import * as Sentry from '@sentry/nuxt'
import { recordPaidTermsAcceptance, requirePaidTermsAccepted } from '../../../../utils/billing/paidTerms'
import { findUserById } from '../../../../repos/users'
import { getWorkspace } from '../../../../repos/workspaces'
import { getWorkspaceSubscription } from '../../../../repos/workspaceSubscriptions'
import { appendAuditEvent } from '../../../../repos/audit'
import { assertBillingEnabled } from '../../../../utils/billing/billingMode'
import { useStripeClient } from '../../../../utils/billing/stripeClient'
import { stripePriceIdFor } from '../../../../utils/billing/stripePrices'
import { findLiveSubscription } from '../../../../utils/billing/stripePlanChange'
import { ensureWorkspaceCustomer, requestBaseUrl, expireOpenWorkspaceCheckouts } from '../../../../utils/billing/workspaceStripe'
import { countSeatsUsed, parseSeats, requireWorkspaceBillingAdmin } from '../../../../utils/billing/workspaceBilling'
import { WORKSPACE_REF_PREFIX } from '../../../../utils/billing/stripeWebhook'
import {
  AUDIT_WORKSPACE_BILLING_CHECKOUT_STARTED,
  AUDIT_WORKSPACE_BILLING_PLAN_CHANGED
} from '../../../../legal/auditActions'
import { isBillingInterval, isCurrency } from '~~/shared/config/pricing'
import { isWorkspacePlan, type PlanName } from '~~/shared/config/tiers'

// POST /api/workspaces/:wsId/billing/checkout — buy Team / Business for a
// workspace, or change the plan / billing period of its live subscription
// Workspace admins only; the caller becomes the billing admin.
//
// Body: {plan: 'team'|'business', interval?: 'month'|'year',
//        currency?: 'eur'|'chf', seats: ≥ 3 (and ≥ members + open invites)}
//
//   - no live subscription → Stripe Checkout (`mode: subscription`,
//     quantity = seats, adjustable on the Stripe page) on the workspace's
//     own customer; `client_reference_id = workspace:<id>` →
//     `{url, sessionId}`. The webhook writes plan / seats / status.
//   - live subscription → in-place price swap (Team ↔ Business, monthly ↔
//     annual), quantity kept (seat changes: `/billing/seats`) →
//     `{updated: true, plan}`; same price → 409.
// A workspace keeps one currency (its Stripe customer's): 409
// `billing/currency-locked` for the other.
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  assertBillingEnabled()
  const wsId = requireWsId(event)
  const userId = session.user.id
  await requireWorkspaceBillingAdmin(userId, wsId)

  if (!(await checkRateLimit('billing-checkout', String(userId), 10, 60_000))) {
    throw createError({
      statusCode: 429,
      message: 'Too many checkout attempts. Try again in a minute.',
      data: { code: 'billing/rate-limited', messageKey: 'error.rateLimited' }
    })
  }

  const body = await readBody<{ plan?: unknown, interval?: unknown, currency?: unknown, seats?: unknown }>(event)
  const plan = typeof body?.plan === 'string' ? body.plan as PlanName : null
  if (!plan || !isWorkspacePlan(plan)) {
    throw createError({ statusCode: 400, message: 'Invalid plan. Must be team or business.' })
  }
  const interval = body?.interval === undefined ? 'month' : body.interval
  if (!isBillingInterval(interval)) throw createError({ statusCode: 400, message: 'Invalid interval. Must be month or year.' })
  if (body?.currency !== undefined && !isCurrency(body.currency)) {
    throw createError({ statusCode: 400, message: 'Invalid currency. Must be eur or chf.' })
  }

  const stripe = useStripeClient()
  if (!stripe) throw createError({ statusCode: 503, message: 'Billing is not configured. Contact support.' })

  const existing = await getWorkspaceSubscription(wsId)
  const currency = isCurrency(body?.currency) ? body.currency : (existing?.currency ?? 'eur')
  if (existing?.stripeCustomerId && existing.stripeSubscriptionId && currency !== existing.currency) {
    throw createError({
      statusCode: 409,
      message: `This workspace is billed in ${existing.currency.toUpperCase()}; it can't switch currency.`,
      data: { code: 'billing/currency-locked', currency: existing.currency, messageKey: 'pricing.currencyLocked' }
    })
  }
  const priceId = await stripePriceIdFor(stripe, plan, interval, currency)
  if (!priceId) {
    throw createError({ statusCode: 503, message: `No Stripe price is set up for ${plan} (${interval}, ${currency.toUpperCase()}).` })
  }
  requirePaidTermsAccepted(body)

  let liveSub
  try {
    liveSub = await findLiveSubscription(stripe, existing?.stripeSubscriptionId ?? null)
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'billing', event: 'workspace_subscription_probe_failed', workspaceId: wsId } })
    throw createError({ statusCode: 502, message: 'Could not verify the current subscription. Please try again.' })
  }

  if (liveSub) {
    const item = liveSub.items.data[0]
    if (!item) throw createError({ statusCode: 502, message: 'The subscription has no items.' })
    if (item.price?.id === priceId) {
      throw createError({ statusCode: 409, message: `This workspace is already on ${plan} (${interval === 'year' ? 'annual' : 'monthly'}).` })
    }
    try {
      await stripe.subscriptions.update(liveSub.id, {
        items: [{ id: item.id, price: priceId, quantity: item.quantity ?? existing?.seats ?? 1 }],
        proration_behavior: 'always_invoice',
        payment_behavior: 'error_if_incomplete',
        cancel_at_period_end: false
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Stripe error'
      Sentry.captureException(e, { tags: { component: 'billing', event: 'workspace_plan_change_failed', workspaceId: wsId } })
      throw createError({ statusCode: 502, message: `Could not change the plan: ${msg}` })
    }
    await appendAuditEvent({
      actorUserId: userId,
      actorIp: getClientIp(event),
      scope: 'billing',
      scopeId: wsId,
      action: AUDIT_WORKSPACE_BILLING_PLAN_CHANGED,
      before: existing ? { plan: existing.plan, interval: existing.interval } : null,
      after: { plan, interval },
      metadata: undefined
    })
    await recordPaidTermsAcceptance(event, userId, { kind: 'plan', subject: { type: 'workspace', id: wsId }, item: `${plan}_${interval}` })
    return { updated: true, plan }
  }

  // New subscription: seats can't be fewer than the people already in it.
  const seats = parseSeats(body?.seats)
  const used = await countSeatsUsed(wsId)
  if (seats < used) {
    throw createError({
      statusCode: 409,
      message: `This workspace already has ${used} members and open invitations; buy at least ${used} seats.`,
      data: { code: 'billing/seats-below-members', used, messageKey: 'workspace.billing.errors.seatsBelowMembers' }
    })
  }

  const [workspace, admin] = await Promise.all([getWorkspace(wsId), findUserById(userId)])
  const customerId = await ensureWorkspaceCustomer(stripe, {
    workspaceId: wsId,
    workspaceName: workspace?.name ?? '',
    billingAdminId: userId,
    billingAdminEmail: admin?.email ?? null,
    plan,
    seats,
    currency,
    interval,
    existing
  })

  const base = requestBaseUrl(event)
  const taxEnabled = ['1', 'true', 'yes'].includes(String(useRuntimeConfig(event).stripe.automaticTax || '').toLowerCase())
  const metadata = { subject_type: 'workspace', subject_id: wsId, billing_admin_id: String(userId) }
  try {
    // Only the newest Checkout of a workspace can be paid.
    await expireOpenWorkspaceCheckouts(stripe, customerId)
    const checkout = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: `${WORKSPACE_REF_PREFIX}${wsId}`,
      line_items: [{
        price: priceId,
        quantity: seats,
        adjustable_quantity: { enabled: true, minimum: Math.max(used, 3), maximum: 1000 }
      }],
      metadata,
      subscription_data: { metadata },
      success_url: `${base}/w/${encodeURIComponent(wsId)}?billing=success`,
      cancel_url: `${base}/w/${encodeURIComponent(wsId)}?billing=cancelled`,
      ...(taxEnabled
        ? {
            automatic_tax: { enabled: true },
            billing_address_collection: 'required' as const,
            tax_id_collection: { enabled: true },
            customer_update: { address: 'auto' as const, name: 'auto' as const }
          }
        : {})
    })
    if (!checkout.url) throw createError({ statusCode: 502, message: 'Stripe did not return a Checkout URL' })
    await appendAuditEvent({
      actorUserId: userId,
      actorIp: getClientIp(event),
      scope: 'billing',
      scopeId: wsId,
      action: AUDIT_WORKSPACE_BILLING_CHECKOUT_STARTED,
      before: null,
      after: null,
      metadata: { plan, seats, interval, currency }
    })
    await recordPaidTermsAcceptance(event, userId, { kind: 'plan', subject: { type: 'workspace', id: wsId }, item: `${plan}_${interval}` })
    return { url: checkout.url, sessionId: checkout.id }
  } catch (e) {
    if ((e as { statusCode?: number })?.statusCode) throw e
    const msg = e instanceof Error ? e.message : 'Stripe error'
    Sentry.captureException(e, { tags: { component: 'billing', event: 'workspace_checkout_create_failed', workspaceId: wsId } })
    throw createError({ statusCode: 502, message: `Could not start checkout: ${msg}` })
  }
})
