import type Stripe from 'stripe'
import * as Sentry from '@sentry/nuxt'
import { recordSeatChange, recordWorkspaceStripeCustomer, setWorkspaceBillingAdmin } from '../../repos/workspaceSubscriptions'
import type { WorkspaceAccess } from '../../repos/proofs'
import { findLiveSubscription, PAID_CHANGE_PARAMS, paymentPendingError, pendingPayment } from './stripePlanChange'
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
 * - More seats: invoiced and paid NOW (`PAID_CHANGE_PARAMS`, like a plan
 *   upgrade). When the payment needs the admin (3-D Secure, a declined
 *   card) Stripe keeps the new count pending and this throws 402
 *   `billing/payment-pending` with nothing written: seats bought on credit
 *   would unlock the pooled AI budget before anything was paid. Once the
 *   invoice is paid the `customer.subscription.updated` webhook writes the
 *   seats (and the team budget follows); unpaid, the change lapses.
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
  const updated = await stripe.subscriptions.update(sub.id, {
    items: [{ id: item.id, quantity: seats }],
    ...(adding ? PAID_CHANGE_PARAMS : { proration_behavior: 'none' as const })
  })
  const pending = pendingPayment(updated)
  if (pending) throw paymentPendingError(pending)
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
 * Expire the workspace customer's other open Checkout Sessions before a
 * new one is created, so only the newest can still be paid (two admins,
 * or two tabs, would otherwise each buy a subscription). The webhook
 * still cancels a duplicate that slips through
 * (`cancelDuplicateSubscription`).
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
