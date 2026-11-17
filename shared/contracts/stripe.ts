/**
 * Shared Stripe contracts.
 *
 * Centralises (a) the API-version pin and (b) the webhook event types
 * whose delivery order matters. Consumers that MUST agree on both:
 *   - `server/utils/billing/stripeClient.ts` (constructs the SDK client)
 *   - `server/utils/billing/stripeWebhook.ts` (the dispatcher; its handler
 *     table, `stripeEvents/eventHandlers.ts`, is the list of handled types)
 *   - `tests/**` (fixtures that produce typed minimal events)
 *
 * Why this matters: the Stripe API version dictates the wire shape
 * of every event payload. Bumping the version in one place and
 * forgetting the other leads to handlers that compile but read
 * fields that no longer exist (silent null), or fields that shifted
 * location (e.g. `current_period_start` moved from the subscription
 * root to the subscription ITEM in the 2025-01-27 release, see
 * `subscriptionPeriod` in `server/utils/billing/stripeEvents/stripeObjects.ts`).
 *
 * The handler table checks each entry against the SDK's own type for its
 * event, so a handler reads the fields of the pinned version's payload.
 */

import type Stripe from 'stripe'

/**
 * The Stripe API version this codebase speaks. Pinning decouples our
 * code from Stripe's rolling defaults, subscription period fields
 * and other objects change shape across versions, and we want our
 * webhook handlers to see a stable schema across deployments.
 *
 * It is the version of the installed `stripe` SDK's types, so the types
 * describe exactly what the API returns. Stripe Managed Payments needs
 * 2025-03-31.basil or later.
 *
 * Bumping this value is a coordinated change:
 *   1. Read the Stripe upgrade guide for the target version
 *   2. Update the version-dependent reads in `stripeEvents/stripeObjects.ts`
 *      (`current_period_start` etc. that move locations); keep reading the
 *      old place too, events stashed in `pending_stripe_events` before the
 *      bump still have the old shape
 *   3. Re-run the full webhook test suite
 *   4. Update STRIPE_API_VERSION here as the LAST step
 *   5. Operators: the webhook endpoint in the Stripe dashboard renders
 *      events in its own API version; set it to the same version
 */
export const STRIPE_API_VERSION = '2026-09-30.endive'

/**
 * The handled events whose ordering matters, those that
 * can arrive BEFORE `checkout.session.completed` binds the
 * customerId to a user row, and therefore need to be stashed in
 * `pending_stripe_events` until the bind happens.
 *
 * Used by `dispatchStripeEvent` to decide whether to run the stash
 * branch on a customer-id-without-user-row miss. `checkout.session.completed`
 * is intentionally NOT in this list, it's the binding event itself.
 */
export const ORDER_SENSITIVE_STRIPE_EVENT_TYPES = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed'
] as const

export type OrderSensitiveStripeEventType = typeof ORDER_SENSITIVE_STRIPE_EVENT_TYPES[number]
/** An order-sensitive event; also the shape stashed in `pending_stripe_events.payload`. */
export type OrderSensitiveStripeEvent = Extract<Stripe.Event, { type: OrderSensitiveStripeEventType }>

/**
 * Type-narrowing helper: given any Stripe.Event, returns true if it's
 * one of the order-sensitive types (and narrows the type accordingly).
 * The dispatcher uses this to decide whether to run the stash branch.
 */
export function isOrderSensitiveStripeEvent(
  event: Stripe.Event
): event is OrderSensitiveStripeEvent {
  return (ORDER_SENSITIVE_STRIPE_EVENT_TYPES as readonly string[]).includes(event.type)
}

/**
 * Answer of the plan checkout routes (personal and workspace): either the
 * live subscription was switched in place (`updated`), or a Stripe Checkout
 * session was opened for the browser to follow (`url`).
 */
export type PlanCheckoutResponse<P extends string>
  = | { updated: true, plan: P, interval: 'month' | 'year' }
    | { url: string | null, sessionId: string }

/**
 * The subscription statuses of the pinned API version, as stored in
 * `workspace_subscriptions.status`. Stripe's own type also admits any other
 * string (statuses added in later API versions).
 */
export const STRIPE_SUBSCRIPTION_STATUSES = ['active', 'canceled', 'incomplete', 'incomplete_expired', 'past_due', 'paused', 'trialing', 'unpaid'] as const
export type StripeSubscriptionStatus = typeof STRIPE_SUBSCRIPTION_STATUSES[number]

export function isKnownSubscriptionStatus(status: string): status is StripeSubscriptionStatus {
  return (STRIPE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status)
}

/**
 * A payment is overdue: the last invoice was not paid and Stripe is still
 * retrying (`past_due`) or has stopped retrying without ending the
 * subscription (`unpaid`). The billing pages say so and link to the portal.
 */
export function isPaymentOverdueStatus(status: string | null | undefined): boolean {
  return status === 'past_due' || status === 'unpaid'
}
