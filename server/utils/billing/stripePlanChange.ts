// In-place subscription plan changes (upgrades between paid tiers).
//
// Why this exists: `checkout.sessions.create({mode: 'subscription'})`
// ALWAYS creates a NEW subscription. For a user who already has an
// active one, that means two concurrent subscriptions billing the same
// customer: the classic Stripe upgrade footgun. The checkout endpoint
// therefore probes the user's existing subscription first and, when
// it's live, swaps the price on the EXISTING subscription instead of
// opening Checkout. The `customer.subscription.updated` webhook then
// flips `users.plan`, stamps the new period, and syncs the LiteLLM
// key budget (see stripeWebhook.ts#handleSubscriptionUpdated).

import type Stripe from 'stripe'
import { subscriptionPeriod } from './stripeEvents/stripeObjects'
import { apiError } from '../api/apiError'

/**
 * Subscription statuses that mean "this customer is already being
 * billed (or Stripe is still trying)", creating a second subscription
 * for them would double-bill. `past_due`/`unpaid` are included on
 * purpose: dunning hasn't given up yet, so the right move is still to
 * modify the existing subscription, never to add another one.
 * `canceled` / `incomplete_expired` are terminal, those users go
 * through Checkout again like a fresh subscriber.
 */
const LIVE_SUBSCRIPTION_STATUSES: readonly Stripe.Subscription.Status[] = [
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'incomplete'
]

export function isLiveSubscriptionStatus(status: string): boolean {
  return (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status)
}

/**
 * Retrieve the user's recorded subscription and return it only if it's
 * still live. Returns null when the id is absent, the subscription no
 * longer exists on Stripe's side (deleted + webhook lost), or its
 * status is terminal: all cases where a fresh Checkout is correct.
 */
export async function findLiveSubscription(
  stripe: Stripe,
  stripeSubscriptionId: string | null
): Promise<Stripe.Subscription | null> {
  if (!stripeSubscriptionId) return null
  try {
    const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId)
    return isLiveSubscriptionStatus(sub.status) ? sub : null
  } catch (e) {
    // `resource_missing` = the subscription id we recorded is gone on
    // Stripe's side (e.g. deleted in the dashboard and the webhook got
    // lost). Fresh Checkout is the correct recovery. Anything else
    // (auth, network) must propagate, silently treating an outage as
    // "no subscription" would re-open the double-subscription bug.
    const code = (e as { code?: string })?.code
    if (code === 'resource_missing') return null
    throw e
  }
}

/**
 * How a change that costs money is paid (plan, billing period, more seats).
 *
 * - `always_invoice`: the prorated difference is invoiced and charged NOW;
 *   the bigger AI budget follows at once, so it is paid at once.
 * - `pending_if_incomplete`: the change is applied only once that invoice
 *   is paid. When the payment needs the buyer (3-D Secure, a declined
 *   card) Stripe keeps the change as the subscription's `pending_update`
 *   and nothing changes: no plan, seat or budget is unlocked on credit.
 *   Paying the invoice within about a day applies it (the
 *   `customer.subscription.updated` webhook then writes the new state);
 *   otherwise Stripe voids the invoice and drops the change. Stripe
 *   Managed Payments supports it on its subscriptions, and unlike
 *   `error_if_incomplete` it does not just fail when the bank asks for
 *   3-D Secure.
 * - `expand: ['latest_invoice']`: the invoice to pay when the change waits.
 */
export const PAID_CHANGE_PARAMS = {
  proration_behavior: 'always_invoice',
  payment_behavior: 'pending_if_incomplete',
  expand: ['latest_invoice']
} as const satisfies Stripe.SubscriptionUpdateParams

/**
 * Swap the subscription's (single) price item to the new plan's price,
 * paid now (`PAID_CHANGE_PARAMS`). `quantity` keeps a workspace's seats.
 * `cancel_at_period_end: false`: an upgrade is an explicit "I'm staying"
 * and un-schedules a pending cancellation.
 */
export async function changeSubscriptionPrice(
  stripe: Stripe,
  sub: Stripe.Subscription,
  newPriceId: string,
  quantity?: number
): Promise<Stripe.Subscription> {
  const item = sub.items.data[0]
  if (!item) {
    throw new Error(`Subscription ${sub.id} has no items, cannot change plan`)
  }
  return await stripe.subscriptions.update(sub.id, {
    items: [{ id: item.id, price: newPriceId, ...(quantity === undefined ? {} : { quantity }) }],
    ...PAID_CHANGE_PARAMS,
    cancel_at_period_end: false
  })
}

/**
 * The change Stripe keeps waiting for its payment (`pending_if_incomplete`),
 * or null when it was applied. `paymentUrl`: the hosted page of the invoice
 * to pay, when Stripe returned one. A pending update always expires in the
 * future (at most about a day after the request); one that has already
 * expired holds nothing (stripe-mock answers every update with such a
 * canned, long-expired `pending_update`).
 */
export function pendingPayment(sub: Stripe.Subscription, now: Date = new Date()): { paymentUrl: string | null } | null {
  const pending = sub.pending_update
  if (!pending || pending.expires_at * 1000 <= now.getTime()) return null
  const invoice = sub.latest_invoice
  const paymentUrl = invoice && typeof invoice === 'object' ? invoice.hosted_invoice_url ?? null : null
  return { paymentUrl }
}

/**
 * 402 `billing/payment-pending` for a change that waits for its payment;
 * the client shows the link to pay the invoice as the toast's action.
 */
export function paymentPendingError(pending: { paymentUrl: string | null }) {
  return apiError('billing/payment-pending', pending.paymentUrl
    ? { recovery: { kind: 'link', href: pending.paymentUrl, labelKey: 'billing.completePayment' } }
    : {})
}

/**
 * The current period of a subscription that was just changed, for writing
 * it locally ahead of the webhook. A live subscription's period always
 * ends in the future, so anything else (a field the API version does not
 * carry) is left for the webhook to write.
 */
export function livePeriod(sub: Stripe.Subscription, now: Date = new Date()): { start: Date, end: Date } | null {
  const { start, end } = subscriptionPeriod(sub)
  return start && end && end.getTime() > now.getTime() ? { start, end } : null
}
