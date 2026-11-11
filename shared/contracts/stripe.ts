/**
 * Shared Stripe contracts.
 *
 * Centralises (a) the API-version pin and (b) the literal-union of
 * webhook event types we handle. Two consumers MUST agree on both:
 *   - `server/utils/billing/stripeClient.ts` (constructs the SDK client)
 *   - `server/utils/billing/stripeWebhook.ts` (the dispatcher's switch table)
 *   - `tests/**` (fixtures that produce typed minimal events)
 *
 * Why this matters: the Stripe API version dictates the wire shape
 * of every event payload. Bumping the version in one place and
 * forgetting the other leads to handlers that compile but read
 * fields that no longer exist (silent null), or fields that shifted
 * location (e.g. `current_period_start` moved from the subscription
 * root to the subscription ITEM in the 2025-01-27 release — see the
 * cast-through-unknown in `handleCheckoutSessionCompleted`).
 *
 * Pinning the literal type union here lets the dispatcher's switch
 * be exhaustive-checked at compile time: a new handled event type
 * gets added here first, then the dispatcher gets a "switch case
 * missing" error until the handler lands. Same shape as a discriminated
 * union — TS narrows on `event.type` once we constrain the union.
 */

import type Stripe from 'stripe'

// Stripe SDK 22.x exposes `StripeConfig.apiVersion` as `string`
// rather than a literal-union, so we ship the version as a const
// string. Earlier major versions exported `Stripe.LatestApiVersion`;
// future bumps may bring it back. If TS narrows it again, swap the
// cast below to `as Stripe.LatestApiVersion`.

/**
 * The Stripe API version this codebase speaks. Pinning decouples our
 * code from Stripe's rolling defaults — subscription period fields
 * and other objects change shape across versions, and we want our
 * webhook handlers to see a stable schema across deployments.
 *
 * Bumping this value is a coordinated change:
 *   1. Read the Stripe upgrade guide for the target version
 *   2. Update the cast-through-unknown shapes in stripeWebhook.ts
 *      (`current_period_start` etc. that move locations)
 *   3. Re-run the full webhook test suite
 *   4. Update STRIPE_API_VERSION here as the LAST step
 *
 * Cast as `Stripe.LatestApiVersion` so the SDK constructor signature
 * accepts it without each consumer having to repeat the cast.
 */
export const STRIPE_API_VERSION = '2025-01-27.acacia'

/**
 * The webhook event types we handle in `dispatchStripeEvent` →
 * `runHandler`. Anything NOT in this list is acknowledged as
 * `handled: false` and the dispatcher returns 200 to Stripe (so
 * Stripe stops retrying). The list is exposed as both a runtime
 * `as const` array AND a literal-union type so:
 *   - test fixtures can use the TYPE to constrain `event.type`
 *   - a runtime sweeper can use the ARRAY to validate stash entries
 *
 * **Order matters for the dispatcher's switch statement** — the
 * subscription-related events MUST stay grouped because they
 * fall-through to a single handler. Don't reorder without updating
 * `runHandler`.
 *
 * Add a new event type here to make the dispatcher's switch a
 * compile error until the handler lands.
 */
export const HANDLED_STRIPE_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed'
] as const

/**
 * The subset of handled events whose ordering matters — those that
 * can arrive BEFORE `checkout.session.completed` binds the
 * customerId to a user row, and therefore need to be stashed in
 * `pending_stripe_events` until the bind happens.
 *
 * Used by `dispatchStripeEvent` to decide whether to run the stash
 * branch on a customer-id-without-user-row miss. `checkout.session.completed`
 * is intentionally NOT in this list — it's the binding event itself.
 */
export const ORDER_SENSITIVE_STRIPE_EVENT_TYPES = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed'
] as const

export type OrderSensitiveStripeEventType = typeof ORDER_SENSITIVE_STRIPE_EVENT_TYPES[number]

/**
 * Type-narrowing helper: given any Stripe.Event, returns true if it's
 * one of the order-sensitive types (and narrows the type accordingly).
 * The dispatcher uses this to decide whether to run the stash branch.
 */
export function isOrderSensitiveStripeEvent(
  event: Stripe.Event
): event is Stripe.Event & { type: OrderSensitiveStripeEventType } {
  return (ORDER_SENSITIVE_STRIPE_EVENT_TYPES as readonly string[]).includes(event.type)
}
