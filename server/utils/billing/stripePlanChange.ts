// In-place subscription plan changes (upgrades between paid tiers).
//
// Why this exists: `checkout.sessions.create({mode: 'subscription'})`
// ALWAYS creates a NEW subscription. For a user who already has an
// active one, that means two concurrent subscriptions billing the same
// customer — the classic Stripe upgrade footgun. The checkout endpoint
// therefore probes the user's existing subscription first and, when
// it's live, swaps the price on the EXISTING subscription instead of
// opening Checkout. The `customer.subscription.updated` webhook then
// flips `users.plan`, stamps the new period, and syncs the LiteLLM
// key budget (see stripeWebhook.ts#handleSubscriptionUpdated).

import type Stripe from 'stripe'

/**
 * Subscription statuses that mean "this customer is already being
 * billed (or Stripe is still trying)" — creating a second subscription
 * for them would double-bill. `past_due`/`unpaid` are included on
 * purpose: dunning hasn't given up yet, so the right move is still to
 * modify the existing subscription, never to add another one.
 * `canceled` / `incomplete_expired` are terminal — those users go
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
 * status is terminal — all cases where a fresh Checkout is correct.
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
    // (auth, network) must propagate — silently treating an outage as
    // "no subscription" would re-open the double-subscription bug.
    const code = (e as { code?: string })?.code
    if (code === 'resource_missing') return null
    throw e
  }
}

/**
 * Swap the subscription's (single) price item to the new plan's price.
 *
 * - `always_invoice`: charge the prorated difference NOW — the user
 *   expects the bigger AI budget immediately, so they pay immediately.
 * - `error_if_incomplete`: if the payment fails, the API call errors
 *   and NOTHING changes (no half-upgraded state); the caller surfaces
 *   the error and the user fixes their card in the Customer Portal.
 * - `cancel_at_period_end: false`: an upgrade is an explicit "I'm
 *   staying" — it un-schedules any pending cancellation.
 */
export async function changeSubscriptionPrice(
  stripe: Stripe,
  sub: Stripe.Subscription,
  newPriceId: string
): Promise<Stripe.Subscription> {
  const item = sub.items.data[0]
  if (!item) {
    throw new Error(`Subscription ${sub.id} has no items — cannot change plan`)
  }
  return await stripe.subscriptions.update(sub.id, {
    items: [{ id: item.id, price: newPriceId }],
    proration_behavior: 'always_invoice',
    payment_behavior: 'error_if_incomplete',
    cancel_at_period_end: false
  })
}
