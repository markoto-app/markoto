import type Stripe from 'stripe'
import * as Sentry from '@sentry/nuxt'
import { recordSeatChange, recordWorkspaceStripeCustomer, setWorkspaceBillingAdmin } from '../../repos/workspaceSubscriptions'
import type { WorkspaceAccess } from '../../repos/proofs'
import { findLiveSubscription } from './stripePlanChange'
import { stripeResponseTime } from './stripeEvents/eventAge'
import { changedSeatBudgetAdjust } from './workspaceBilling'
import { readWorkspaceTeam } from '../litellm/workspaceTeams'
import { releaseSessionLock, tryAcquireSessionLock } from '../platform/rateLimit'
import type { WorkspaceSubscriptionRow } from '../../repos/workspaceSubscriptions'
import type { BillingInterval, Currency } from '~~/shared/config/pricing'
import type { WorkspacePlanName } from '~~/shared/config/tiers'
import { apiError } from '../api/apiError'
import { useLogger } from '../platform/logger'

const log = useLogger('workspace-stripe')

// Stripe side of Team / Business workspace subscriptions.
//
// Each workspace gets its OWN Stripe customer (metadata `workspace_id`),
// never the billing admin's personal one: invoices name the workspace,
// a personal Pro and a Team subscription never share a customer, and the
// webhook routes events by customer (`stripeWebhook.ts#subjectForCustomer`).
// The customer id is stored on a `workspace_subscriptions` row with
// status `incomplete` BEFORE the Checkout Session exists, so a
// `customer.subscription.*` event that beats `checkout.session.completed`
// already finds its workspace (and `incomplete` grants nothing).

/** Stripe answers `resource_missing` for a deleted / unknown object. */
function isMissing(e: unknown): boolean {
  return (e as { code?: string })?.code === 'resource_missing'
}

/**
 * The workspace's Stripe customer, created on first checkout, plus the
 * `incomplete` placeholder row. Never touches an existing row's plan /
 * seats / status (an entitled subscription is changed, not re-bought).
 */
export async function ensureWorkspaceCustomer(stripe: Stripe, ws: WorkspaceAccess<'admin'>, args: {
  workspaceName: string
  billingAdminId: number
  billingAdminEmail: string | null
  plan: WorkspacePlanName
  seats: number
  currency: Currency
  interval: BillingInterval
  existing: WorkspaceSubscriptionRow | null
}): Promise<string> {
  if (args.existing?.stripeCustomerId) {
    await setWorkspaceBillingAdmin(ws, args.billingAdminId)
    return args.existing.stripeCustomerId
  }
  const customer = await stripe.customers.create({
    name: args.workspaceName || undefined,
    ...(args.billingAdminEmail ? { email: args.billingAdminEmail } : {}),
    metadata: { workspace_id: ws.workspaceId, subject_type: 'workspace' }
  })
  await recordWorkspaceStripeCustomer(ws, {
    plan: args.plan,
    seats: args.seats,
    billingAdminId: args.billingAdminId,
    stripeCustomerId: customer.id,
    currency: args.currency,
    interval: args.interval
  })
  return customer.id
}

/**
 * Change the paid seats of a live subscription.
 *
 * - More seats: invoiced and paid NOW (`always_invoice` +
 *   `error_if_incomplete`, like a plan upgrade). A failed payment throws
 *   and changes nothing: seats bought on credit would unlock the
 *   pooled AI budget before anything was paid.
 * - Fewer seats: no credit for the running period
 *   (`proration_behavior: 'none'`); the next invoice bills the new count.
 *   A credit would let an admin add seats, spend their budget and get
 *   the money back by removing them again.
 *
 * The pooled budget follows `changedSeatBudgetAdjust`: added seats unlock
 * budget for the days left in the LiteLLM budget window, removed seats
 * keep theirs until the window ends. The local row is written right away
 * (an invite that adds a seat can go through); the
 * `customer.subscription.updated` webhook writes the same seat count.
 */
/** `ws`: the admin buying or removing seats, for `row`'s workspace. */
export async function changeWorkspaceSeats(stripe: Stripe, ws: WorkspaceAccess<'admin'>, row: WorkspaceSubscriptionRow, seats: number, now: Date = new Date()): Promise<void> {
  if (ws.workspaceId !== row.workspaceId) throw new Error('changeWorkspaceSeats: the subscription row belongs to another workspace')
  const sub = await findLiveSubscription(stripe, row.stripeSubscriptionId)
  const item = sub?.items.data[0]
  if (!sub || !item) {
    throw apiError('billing/no-subscription')
  }
  // The budget window has to be known BEFORE anything is charged: without
  // it the added seats' budget can't be prorated.
  let windowEnd: Date | null
  try {
    const resetAt = (await readWorkspaceTeam(row.workspaceId))?.budget_reset_at
    windowEnd = resetAt ? new Date(resetAt) : null
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'billing', event: 'workspace_team_read_failed', workspaceId: row.workspaceId } })
    throw createError({ statusCode: 503, message: 'Could not read the workspace\'s AI budget. Nothing was changed; please try again.' })
  }
  const from = item.quantity ?? row.seats
  const adding = seats > from
  await stripe.subscriptions.update(sub.id, {
    items: [{ id: item.id, quantity: seats }],
    ...(adding
      ? { proration_behavior: 'always_invoice' as const, payment_behavior: 'error_if_incomplete' as const }
      : { proration_behavior: 'none' as const })
  })
  const budget = changedSeatBudgetAdjust({ current: row, from, to: seats, windowEnd, now })
  // `at`: Stripe's time just before the change, so an event of the previous seat count is not applied over it.
  await recordSeatChange(ws, { seats, budgetSeatAdjust: budget.adjust, budgetSeatAdjustUntil: budget.until, at: stripeResponseTime(sub) })
}

/** How long a seat lock may be held (a Stripe charge plus the invite write). */
const SEAT_LOCK_TTL_MS = 60_000

/**
 * Serialise everything that counts a pooled workspace's seats and acts
 * on the count (invites, seat changes): two admins inviting at once would
 * otherwise both see the same free seat, or both buy "seat N + 1" and end
 * one seat over what was paid. Returns the release function; a held lock
 * (or Valkey unreachable: the lock fails closed) is a 409 to retry.
 */
export async function acquireWorkspaceSeatLock(workspaceId: string): Promise<() => Promise<void>> {
  if (!(await tryAcquireSessionLock('workspace-seats', workspaceId, SEAT_LOCK_TTL_MS))) {
    throw apiError('billing/seats-busy')
  }
  return () => releaseSessionLock('workspace-seats', workspaceId)
}

/**
 * The HTTP error for a failed `changeWorkspaceSeats`: our own errors pass
 * through, a declined payment for added seats is a 402 (nothing changed;
 * the admin updates the card in the billing portal), anything else a 502.
 */
export function seatChangeError(e: unknown, workspaceId: string): Error {
  if ((e as { statusCode?: number })?.statusCode) return e as Error
  const msg = e instanceof Error ? e.message : 'Stripe error'
  if ((e as { type?: string })?.type === 'StripeCardError') {
    return apiError('billing/payment-failed', { detail: msg })
  }
  Sentry.captureException(e, { tags: { component: 'billing', event: 'workspace_seats_failed', workspaceId } })
  return createError({ statusCode: 502, message: `Could not change the seats: ${msg}` })
}

/**
 * A second subscription for a workspace that already has a live one (two
 * admins, or two tabs, each completed a Checkout). Cancel it at once and
 * refund what its first invoice took, the workspace keeps the first
 * subscription. Safe to repeat (a webhook retry): a cancelled
 * subscription is not cancelled again, and each refund carries an
 * idempotency key per payment. A refund that fails is reported (error
 * level) for a manual refund instead of failing the webhook.
 */
export async function cancelDuplicateWorkspaceSubscription(stripe: Stripe, sub: Stripe.Subscription, workspaceId: string): Promise<{ refunded: number }> {
  if (sub.status !== 'canceled' && sub.status !== 'incomplete_expired') {
    await stripe.subscriptions.cancel(sub.id, { prorate: false, invoice_now: false })
  }
  let refunded = 0
  const invoiceId = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id ?? null
  try {
    for (const paymentIntent of invoiceId ? await paidInvoicePaymentIntents(stripe, invoiceId) : []) {
      await stripe.refunds.create(
        { payment_intent: paymentIntent, metadata: { reason: 'duplicate_workspace_subscription', workspace_id: workspaceId, subscription_id: sub.id } },
        { idempotencyKey: `markoto-duplicate-subscription-refund-${paymentIntent}` }
      )
      refunded++
    }
  } catch (e) {
    log.error('refund of a duplicate subscription failed: refund it manually', { subscriptionId: sub.id, workspaceId, err: e })
    Sentry.captureException(e, { level: 'error', tags: { component: 'billing', event: 'duplicate_subscription_refund_failed', workspaceId } })
  }
  const msg = `[workspaceStripe] duplicate subscription ${sub.id} for workspace ${workspaceId} cancelled, ${refunded} payment(s) refunded`
  log.warn('duplicate subscription cancelled', { subscriptionId: sub.id, workspaceId, refunded })
  Sentry.captureMessage(msg, { level: 'warning', tags: { component: 'billing', event: 'duplicate_subscription_cancelled', workspaceId } })
  return { refunded }
}

/**
 * The payment intents that paid an invoice. The pinned API version
 * (2025-01-27.acacia) names it on the invoice (`payment_intent`, only set
 * once paid); newer versions list it under Invoice Payments.
 */
async function paidInvoicePaymentIntents(stripe: Stripe, invoiceId: string): Promise<string[]> {
  const invoice = await stripe.invoices.retrieve(invoiceId)
  if ('payment_intent' in invoice) {
    const pi: unknown = invoice.payment_intent
    const id = typeof pi === 'string' ? pi : pi && typeof pi === 'object' && 'id' in pi && typeof pi.id === 'string' ? pi.id : null
    return id && invoice.status === 'paid' ? [id] : []
  }
  const ids: string[] = []
  for await (const payment of stripe.invoicePayments.list({ invoice: invoiceId, status: 'paid' })) {
    const pi = payment.payment.payment_intent
    const id = typeof pi === 'string' ? pi : pi?.id
    if (id) ids.push(id)
  }
  return ids
}

/**
 * Expire the workspace customer's other open Checkout Sessions before a
 * new one is created, so only the newest can still be paid (two admins,
 * or two tabs, would otherwise each buy a subscription). The webhook
 * still cancels a duplicate that slips through
 * (`cancelDuplicateWorkspaceSubscription`).
 */
export async function expireOpenWorkspaceCheckouts(stripe: Stripe, customerId: string): Promise<number> {
  let expired = 0
  for await (const session of stripe.checkout.sessions.list({ customer: customerId, status: 'open', limit: 20 })) {
    if (session.mode !== 'subscription') continue
    try {
      await stripe.checkout.sessions.expire(session.id)
      expired++
    } catch (e) {
      // Completed or expired in the meantime: nothing left to expire.
      if ((e as { type?: string })?.type !== 'StripeInvalidRequestError') throw e
    }
  }
  return expired
}

/**
 * Cancel a workspace's subscription now (the workspace is being
 * deleted). Annual plans get a prorated credit on the customer
 * (`prorate: true`; refunds to the card stay a manual Stripe action).
 * An already-gone subscription counts as cancelled; any other Stripe
 * failure throws, so the deletion stops before anything is deleted,
 * otherwise the subscription would keep billing a workspace that no
 * longer exists, with no row left to find it by.
 */
export async function cancelWorkspaceSubscriptionNow(stripe: Stripe, row: WorkspaceSubscriptionRow): Promise<void> {
  if (!row.stripeSubscriptionId) return
  try {
    await stripe.subscriptions.cancel(row.stripeSubscriptionId, { prorate: row.interval === 'year', invoice_now: false })
  } catch (e) {
    if (isMissing(e) || await hasEnded(stripe, row.stripeSubscriptionId)) return
    log.error('cancel on workspace delete failed', { err: e })
    Sentry.captureException(e, { tags: { component: 'billing', event: 'workspace_cancel_failed', workspaceId: row.workspaceId } })
    throw apiError('billing/cancel-failed')
  }
}

/**
 * The subscription has already ended on Stripe's side (a deletion that is
 * retried after its cancel went through but a later step failed, before
 * the `deleted` webhook updated the row). Stripe refuses to cancel twice.
 */
async function hasEnded(stripe: Stripe, subscriptionId: string): Promise<boolean> {
  try {
    const status = (await stripe.subscriptions.retrieve(subscriptionId)).status
    return status === 'canceled' || status === 'incomplete_expired'
  } catch {
    return false
  }
}

/**
 * The subscription has no billing admin left (their account is gone and
 * no other admin could take over): stop renewing; it ends at the period
 * end. Best-effort.
 */
export async function cancelWorkspaceSubscriptionAtPeriodEnd(stripe: Stripe | null, row: WorkspaceSubscriptionRow): Promise<void> {
  if (!stripe || !row.stripeSubscriptionId) return
  try {
    await stripe.subscriptions.update(row.stripeSubscriptionId, { cancel_at_period_end: true })
  } catch (e) {
    if (isMissing(e)) return
    log.error('cancel at period end failed', { err: e })
    Sentry.captureException(e, { tags: { component: 'billing', event: 'workspace_cancel_period_end_failed', workspaceId: row.workspaceId } })
  }
}

/** Request origin for Stripe return URLs (Origin, else Host, both survive Traefik). */
export function requestBaseUrl(event: Parameters<typeof getRequestHeader>[0]): string {
  const origin = getRequestHeader(event, 'origin') ?? getRequestHeader(event, 'host') ?? ''
  return origin.startsWith('http') ? origin : `https://${origin}`
}
