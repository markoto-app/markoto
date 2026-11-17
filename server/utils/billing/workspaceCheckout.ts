import type { H3Event } from 'h3'
import type Stripe from 'stripe'
import * as Sentry from '@sentry/nuxt'
import type { PlanCheckoutResponse } from '~~/shared/contracts/stripe'
import type { WorkspacePlanName } from '~~/shared/config/tiers'
import type { BillingInterval, Currency } from '~~/shared/config/pricing'
import { apiError } from '../api/apiError'
import { getClientIp } from '../platform/clientIp'
import { recordPaidTermsAcceptance, requirePaidTermsAccepted } from './paidTerms'
import { findUserById } from '../../repos/users'
import { getWorkspace } from '../../repos/workspaces'
import { getWorkspaceSubscription, recordWorkspacePlanChange, type WorkspaceSubscriptionRow } from '../../repos/workspaceSubscriptions'
import { appendAuditEvent } from '../../repos/audit'
import { useStripeClient } from './stripeClient'
import { stripePriceIdFor } from './stripePrices'
import { findLiveSubscription, livePeriod } from './stripePlanChange'
import { ensureWorkspaceCustomer, requestBaseUrl, expireOpenWorkspaceCheckouts } from './workspaceStripe'
import { countSeatsUsed, getPooledWorkspace, parseSeats } from './workspaceBilling'
import { ensureWorkspaceTeam, syncAllMemberKeyLimits } from '../litellm/workspaceTeams'
import { WORKSPACE_REF_PREFIX } from './stripeEvents/checkoutCompleted'
import { identifyItem, isWorkspaceIdentity, subscriptionCancelAt } from './stripeEvents/stripeObjects'
import { stripeResponseTime } from './stripeEvents/eventAge'
import { checkoutCompliance, checkoutTaxFields, type CheckoutBuyer } from './checkoutSession'
import { AUDIT_WORKSPACE_BILLING_CHECKOUT_STARTED, AUDIT_WORKSPACE_BILLING_PLAN_CHANGED } from '../../legal/auditActions'
import type { UserScope, WorkspaceAccess } from '../../repos/proofs'

// Buying Team / Business for a workspace, or changing the plan / billing
// period of its live subscription (`POST /api/workspaces/:wsId/billing/checkout`,
// workspace admins only; the caller becomes the billing admin).
//
//   - no live subscription → Stripe Checkout (`mode: subscription`,
//     quantity = seats, adjustable on the Stripe page) on the workspace's
//     own customer; `client_reference_id = workspace:<id>` →
//     `{url, sessionId}`. The webhook writes plan / seats / status.
//   - live subscription → in-place price swap (Team ↔ Business, monthly ↔
//     annual), quantity kept (seat changes: `/billing/seats`) →
//     `{updated: true, plan, interval}`; same price → 409. The request
//     names only what changes: without `plan` the subscription keeps its
//     plan, without `interval` its billing period (read from the live
//     subscription, so a stale page can't reset either). The local row
//     is written at once; the webhook writes the same state again.
// A workspace keeps one currency (its Stripe customer's): 409
// `billing/currency-locked` for the other.

export interface WorkspaceCheckoutRequest {
  /** The workspace admin's proof; the admin is the billing admin of record. */
  ws: WorkspaceAccess<'admin'>
  self: UserScope
  /** Absent: keep the live subscription's plan (a new subscription needs one). */
  plan: WorkspacePlanName | undefined
  /** Absent: keep the live subscription's billing period (a new subscription is monthly). */
  interval: BillingInterval | undefined
  currency: Currency | undefined
  /** Raw `seats` of the body, judged only when a new subscription needs it (`parseSeats`). */
  seats: unknown
  /** Country and business declaration for the sales-region rule (new Checkout only). */
  buyer?: CheckoutBuyer
  /** The request body: carries the paid-terms acceptance (`requirePaidTermsAccepted`). */
  terms: unknown
}

interface CheckoutContext extends WorkspaceCheckoutRequest {
  plan: WorkspacePlanName
  interval: BillingInterval
  event: H3Event
  stripe: Stripe
  existing: WorkspaceSubscriptionRow | null
  currency: Currency
  priceId: string
}

export async function startWorkspaceCheckout(event: H3Event, request: WorkspaceCheckoutRequest): Promise<PlanCheckoutResponse<WorkspacePlanName>> {
  const wsId = request.ws.workspaceId
  const stripe = useStripeClient()
  if (!stripe) throw apiError('billing/not-configured')

  const existing = await getWorkspaceSubscription(wsId)
  const currency = request.currency ?? existing?.currency ?? 'eur'
  if (existing?.stripeCustomerId && existing.stripeSubscriptionId && currency !== existing.currency) {
    throw apiError('billing/currency-locked', { currency: existing.currency })
  }
  let liveSub
  try {
    liveSub = await findLiveSubscription(stripe, existing?.stripeSubscriptionId ?? null)
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'billing', event: 'workspace_subscription_probe_failed', workspaceId: wsId } })
    throw apiError('billing/subscription-check-failed')
  }
  const { plan, interval } = await requestedPlan(stripe, request, liveSub, existing)
  const priceId = await stripePriceIdFor(stripe, plan, interval, currency)
  if (!priceId) throw apiError('billing/price-unavailable')
  requirePaidTermsAccepted(request.terms)

  const ctx: CheckoutContext = { ...request, plan, interval, event, stripe, existing, currency, priceId }
  return liveSub ? changePlanInPlace(ctx, liveSub) : openCheckout(ctx)
}

/**
 * The plan and billing period the request means. What it leaves out stays
 * as the live subscription has it: Stripe's own price first (the local row
 * can lag a change by one webhook), then the row. A new subscription has
 * nothing to keep: it needs a plan and is monthly unless it says otherwise.
 */
export async function requestedPlan(
  stripe: Stripe,
  request: Pick<WorkspaceCheckoutRequest, 'plan' | 'interval'>,
  liveSub: Stripe.Subscription | null,
  existing: Pick<WorkspaceSubscriptionRow, 'plan' | 'interval'> | null
): Promise<{ plan: WorkspacePlanName, interval: BillingInterval }> {
  if (request.plan && request.interval) return { plan: request.plan, interval: request.interval }
  if (!liveSub) {
    if (!request.plan) throw apiError('request/invalid', { field: 'plan' })
    return { plan: request.plan, interval: request.interval ?? 'month' }
  }
  const identity = await identifyItem(stripe, liveSub.items.data[0])
  const current = isWorkspaceIdentity(identity) ? identity : existing
  const plan = request.plan ?? current?.plan
  if (!plan) throw apiError('request/invalid', { field: 'plan' })
  return { plan, interval: request.interval ?? current?.interval ?? 'month' }
}

async function changePlanInPlace(ctx: CheckoutContext, liveSub: Stripe.Subscription): Promise<PlanCheckoutResponse<WorkspacePlanName>> {
  const { stripe, ws, plan, interval, existing, priceId } = ctx
  const wsId = ws.workspaceId
  const item = liveSub.items.data[0]
  if (!item) throw apiError('billing/plan-change-failed')
  if (item.price?.id === priceId) {
    throw apiError('billing/already-on-plan')
  }
  // Stripe's time just before the change (see `proCheckout.ts`).
  const changedAt = stripeResponseTime(liveSub)
  let updated: Stripe.Subscription
  try {
    updated = await stripe.subscriptions.update(liveSub.id, {
      items: [{ id: item.id, price: priceId, quantity: item.quantity ?? existing?.seats ?? 1 }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
      cancel_at_period_end: false
    })
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'billing', event: 'workspace_plan_change_failed', workspaceId: wsId } })
    throw apiError('billing/plan-change-failed')
  }
  await applyPlanChangeLocally(ctx, updated, changedAt)
  await appendAuditEvent({
    by: ws,
    actorIp: getClientIp(ctx.event),
    scope: 'billing',
    scopeId: wsId,
    action: AUDIT_WORKSPACE_BILLING_PLAN_CHANGED,
    before: existing ? { plan: existing.plan, interval: existing.interval } : null,
    after: { plan, interval },
    metadata: undefined
  })
  await recordPaidTermsAcceptance(ctx.event, ws, { kind: 'plan', subject: { type: 'workspace', id: wsId }, item: `${plan}_${interval}` })
  return { updated: true, plan, interval }
}

/**
 * Stripe has switched the price: write the row and the pooled AI budget
 * now, so the billing tab the admin is looking at shows the new plan
 * without waiting for the webhook (which writes the same state). Never
 * fails the request: the change is already paid for, and the webhook and
 * `litellm-key-reconcile` repair whatever is missed here.
 */
async function applyPlanChangeLocally(ctx: CheckoutContext, updated: Stripe.Subscription, changedAt: Date): Promise<void> {
  const wsId = ctx.ws.workspaceId
  try {
    await recordWorkspacePlanChange(ctx.ws, {
      plan: ctx.plan,
      interval: ctx.interval,
      cancelAt: subscriptionCancelAt(updated),
      period: livePeriod(updated),
      at: changedAt
    })
    const pool = await getPooledWorkspace(wsId)
    if (pool) {
      await ensureWorkspaceTeam(pool)
      await syncAllMemberKeyLimits(pool)
    }
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'billing', event: 'workspace_plan_change_apply_failed', workspaceId: wsId } })
  }
}

async function openCheckout(ctx: CheckoutContext): Promise<PlanCheckoutResponse<WorkspacePlanName>> {
  const { stripe, event, ws, self, plan, interval, currency, priceId, buyer } = ctx
  const wsId = ws.workspaceId
  const userId = self.userId
  // New subscription: seats can't be fewer than the people already in it.
  const seats = parseSeats(ctx.seats)
  const used = await countSeatsUsed(ws)
  if (seats < used) {
    throw apiError('billing/seats-below-members', { used })
  }

  const [workspace, admin] = await Promise.all([getWorkspace(ws), findUserById(self)])
  const customerId = await ensureWorkspaceCustomer(stripe, ws, {
    workspaceName: workspace?.name ?? '',
    billingAdminId: userId,
    billingAdminEmail: admin?.email ?? null,
    plan,
    seats,
    currency,
    interval,
    existing: ctx.existing
  })

  const base = requestBaseUrl(event)
  // A new subscription is a new sale: region rule + IP country evidence.
  const compliance = await checkoutCompliance(event, buyer)
  const metadata = { subject_type: 'workspace', subject_id: wsId, billing_admin_id: String(userId), ...compliance.metadata }
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
      ...checkoutTaxFields(true, { taxIdRequired: compliance.taxIdRequired })
    })
    if (!checkout.url) throw apiError('billing/checkout-failed')
    await appendAuditEvent({
      by: ws,
      actorIp: getClientIp(event),
      scope: 'billing',
      scopeId: wsId,
      action: AUDIT_WORKSPACE_BILLING_CHECKOUT_STARTED,
      before: null,
      after: null,
      metadata: { plan, seats, interval, currency }
    })
    await recordPaidTermsAcceptance(event, ws, { kind: 'plan', subject: { type: 'workspace', id: wsId }, item: `${plan}_${interval}` })
    return { url: checkout.url, sessionId: checkout.id }
  } catch (e) {
    if ((e as { statusCode?: number })?.statusCode) throw e
    Sentry.captureException(e, { tags: { component: 'billing', event: 'workspace_checkout_create_failed', workspaceId: wsId } })
    throw apiError('billing/checkout-failed')
  }
}
