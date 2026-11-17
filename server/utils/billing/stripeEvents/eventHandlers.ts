import type Stripe from 'stripe'
import { handleCheckoutSessionCompleted } from './checkoutCompleted'
import { handleChargeRefunded, handleCheckoutAsyncPaymentFailed, handleCheckoutAsyncPaymentSucceeded } from './creditTopups'
import { handleSubscriptionDeleted, handleSubscriptionUpdated } from './subscriptionEvents'
import { handleInvoicePaid, handleInvoicePaymentFailed } from './invoiceEvents'
import type { StripeHandlerOptions } from './types'

// The Stripe event types the webhook handles, one handler each. This table
// IS the list: an event type without an entry is acknowledged unhandled
// (Stripe sends dozens we don't care about), so a handler is only live once
// it has a row here. The entries are checked against Stripe's own type for
// their event (`satisfies`).

type StripeEventHandler<T extends Stripe.Event['type']> = (
  event: Extract<Stripe.Event, { type: T }>,
  opts: StripeHandlerOptions
) => unknown

const STRIPE_EVENT_HANDLERS = {
  'checkout.session.completed': (event, opts) => handleCheckoutSessionCompleted(event, opts),
  'checkout.session.async_payment_succeeded': (event, opts) => handleCheckoutAsyncPaymentSucceeded(event, opts),
  'checkout.session.async_payment_failed': event => handleCheckoutAsyncPaymentFailed(event),
  'customer.subscription.created': (event, opts) => handleSubscriptionUpdated(event, opts),
  'customer.subscription.updated': (event, opts) => handleSubscriptionUpdated(event, opts),
  'customer.subscription.pending_update_applied': (event, opts) => handleSubscriptionUpdated(event, opts),
  'customer.subscription.deleted': (event, opts) => handleSubscriptionDeleted(event, opts.db, opts.deferAfterCommit),
  'invoice.paid': (event, opts) => handleInvoicePaid(event, opts.db, opts.deferAfterCommit),
  'invoice.payment_failed': (event, opts) => handleInvoicePaymentFailed(event, opts.db, opts.deferAfterCommit),
  'charge.refunded': (event, opts) => handleChargeRefunded(event, opts)
} satisfies { [T in Stripe.Event['type']]?: StripeEventHandler<T> }

export type HandledStripeEventType = keyof typeof STRIPE_EVENT_HANDLERS

/** Every event type the webhook handles, derived from the handler table. */
export const HANDLED_STRIPE_EVENT_TYPES = Object.keys(STRIPE_EVENT_HANDLERS) as readonly HandledStripeEventType[]

function isHandledType(type: string): type is HandledStripeEventType {
  return Object.hasOwn(STRIPE_EVENT_HANDLERS, type)
}

/**
 * Runs an event's handler against the given `db` (top-level pool OR a
 * transaction handle) without doing the dedup INSERT or the out-of-order
 * stash. Used both by `dispatchStripeEvent` AND by the drain logic when
 * replaying stashed events for a now-bound customer.
 */
export async function runStripeEventHandler(
  event: Stripe.Event,
  opts: StripeHandlerOptions
): Promise<{ handled: boolean, detail?: unknown }> {
  // Unhandled events are OK, Stripe sends dozens of types we don't care
  // about. Acknowledge them so Stripe stops retrying.
  if (!isHandledType(event.type)) return { handled: false }
  // The table pairs each type with the handler for that type's event.
  const handler = STRIPE_EVENT_HANDLERS[event.type] as (event: Stripe.Event, opts: StripeHandlerOptions) => unknown
  return { handled: true, detail: await handler(event, opts) }
}
