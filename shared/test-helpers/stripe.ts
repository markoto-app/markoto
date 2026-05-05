/**
 * Test-side Stripe event factories.
 *
 * Construct minimal-but-typed `Stripe.<X>Event` objects for unit
 * tests. Replaces `as unknown as Stripe.Event` casts that can drift
 * from the SDK's actual shape — the casts compile against any
 * shape, so a missing field that the production handler reads
 * would only surface at integration-test time (or worse, in prod).
 *
 * Each factory:
 *   - Accepts the variable parts (customer id, price id, period
 *     timestamps, etc.) that handlers actually read.
 *   - Stamps a typed minimal SDK shape, leaving non-load-bearing
 *     fields at sensible defaults.
 *   - Returns the SDK's discriminated `Stripe.<X>Event` so
 *     `dispatchStripeEvent`'s switch narrows correctly.
 *
 * **PROD CODE MUST NOT IMPORT FROM `shared/test-helpers/`.** See the
 * note in `shared/test-helpers/jwt.ts` for enforcement details.
 *
 * **What this module does NOT cover:** every Stripe field. The SDK's
 * event types have hundreds of fields each; we stamp ONLY the ones
 * our handlers read. If a handler starts reading a new field, that
 * factory needs an additional parameter. The compile error from the
 * SDK type narrowing should make that failure mode loud — if a
 * handler reads `event.data.object.foo` and the factory only sets
 * `bar`, the test passes a typed-correct shape but the handler
 * gets `undefined` at runtime. The test's assertions are the
 * second line of defence.
 */

import type Stripe from 'stripe'

// Sentinel timestamps used as defaults so test fixtures don't have
// to pick numbers themselves. These values land in 2027, well clear
// of "today" so they look unmistakably like fixtures.
const DEFAULT_PERIOD_START_S = 1800000000
const DEFAULT_PERIOD_END_S = 1802678400

/**
 * Build a Stripe.CheckoutSessionCompletedEvent. Reads:
 *   - `data.object.id`
 *   - `data.object.client_reference_id` (the userId as string)
 *   - `data.object.customer` (string OR { id })
 *   - `data.object.subscription` (string OR { id } OR null)
 */
export function makeCheckoutSessionCompletedEvent(opts: {
  eventId?: string
  sessionId?: string
  clientReferenceId: string
  customer: string
  subscription?: string | null
}): Stripe.CheckoutSessionCompletedEvent {
  return {
    id: opts.eventId ?? 'evt_checkout_' + opts.sessionId,
    type: 'checkout.session.completed',
    api_version: null,
    created: 0,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    object: 'event',
    data: {
      object: {
        id: opts.sessionId ?? 'cs_test',
        object: 'checkout.session',
        client_reference_id: opts.clientReferenceId,
        customer: opts.customer,
        subscription: opts.subscription ?? null
      } as unknown as Stripe.Checkout.Session
    }
  } as Stripe.CheckoutSessionCompletedEvent
}

/**
 * Build a Stripe.CustomerSubscription{Created,Updated}Event. Both
 * carry the same shape; the discriminator is `event.type`. Handlers
 * read:
 *   - `data.object.id`
 *   - `data.object.customer` (string OR { id })
 *   - `data.object.items.data[0].price.id`
 *   - `data.object.items.data[0].current_period_start` (item-level
 *     since API version 2025-01-27.acacia)
 *   - `data.object.items.data[0].current_period_end`
 */
export function makeSubscriptionEvent(opts: {
  type: 'customer.subscription.created' | 'customer.subscription.updated'
  eventId?: string
  subscriptionId?: string
  customer: string
  priceId: string
  periodStart?: number
  periodEnd?: number
}): Stripe.CustomerSubscriptionCreatedEvent | Stripe.CustomerSubscriptionUpdatedEvent {
  const subId = opts.subscriptionId ?? 'sub_test'
  return {
    id: opts.eventId ?? 'evt_' + opts.type + '_' + subId,
    type: opts.type,
    api_version: null,
    created: 0,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    object: 'event',
    data: {
      object: {
        id: subId,
        object: 'subscription',
        customer: opts.customer,
        items: {
          data: [{
            id: 'si_test',
            price: { id: opts.priceId },
            current_period_start: opts.periodStart ?? DEFAULT_PERIOD_START_S,
            current_period_end: opts.periodEnd ?? DEFAULT_PERIOD_END_S
          }]
        }
      } as unknown as Stripe.Subscription
    }
  } as Stripe.CustomerSubscriptionCreatedEvent | Stripe.CustomerSubscriptionUpdatedEvent
}

/**
 * Build a Stripe.CustomerSubscriptionDeletedEvent. Handlers read:
 *   - `data.object.id`
 *   - `data.object.customer`
 */
export function makeSubscriptionDeletedEvent(opts: {
  eventId?: string
  subscriptionId?: string
  customer: string
}): Stripe.CustomerSubscriptionDeletedEvent {
  const subId = opts.subscriptionId ?? 'sub_test'
  return {
    id: opts.eventId ?? 'evt_subdel_' + subId,
    type: 'customer.subscription.deleted',
    api_version: null,
    created: 0,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    object: 'event',
    data: {
      object: {
        id: subId,
        object: 'subscription',
        customer: opts.customer
      } as unknown as Stripe.Subscription
    }
  } as Stripe.CustomerSubscriptionDeletedEvent
}

/**
 * Build a Stripe.InvoicePaidEvent. Handlers read:
 *   - `data.object.id`
 *   - `data.object.customer`
 *   - `data.object.subscription`
 *   - `data.object.period_start` / `period_end` (the invoice-level
 *     timestamps Stripe stamps for the cycle this invoice covers)
 */
export function makeInvoicePaidEvent(opts: {
  eventId?: string
  invoiceId?: string
  customer: string
  subscription: string
  periodStart?: number
  periodEnd?: number
}): Stripe.InvoicePaidEvent {
  return {
    id: opts.eventId ?? 'evt_invpaid_' + (opts.invoiceId ?? 'in_test'),
    type: 'invoice.paid',
    api_version: null,
    created: 0,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    object: 'event',
    data: {
      object: {
        id: opts.invoiceId ?? 'in_test',
        object: 'invoice',
        customer: opts.customer,
        subscription: opts.subscription,
        period_start: opts.periodStart ?? DEFAULT_PERIOD_START_S,
        period_end: opts.periodEnd ?? DEFAULT_PERIOD_END_S
      } as unknown as Stripe.Invoice
    }
  } as Stripe.InvoicePaidEvent
}

/**
 * Build a Stripe.InvoicePaymentFailedEvent. Handlers read:
 *   - `data.object.id`
 *   - `data.object.customer`
 *   - `data.object.subscription`
 *   - `data.object.attempt_count`
 */
export function makeInvoicePaymentFailedEvent(opts: {
  eventId?: string
  invoiceId?: string
  customer: string
  subscription: string
  attemptCount?: number
}): Stripe.InvoicePaymentFailedEvent {
  return {
    id: opts.eventId ?? 'evt_invfail_' + (opts.invoiceId ?? 'in_test'),
    type: 'invoice.payment_failed',
    api_version: null,
    created: 0,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    object: 'event',
    data: {
      object: {
        id: opts.invoiceId ?? 'in_test',
        object: 'invoice',
        customer: opts.customer,
        subscription: opts.subscription,
        attempt_count: opts.attemptCount ?? 1
      } as unknown as Stripe.Invoice
    }
  } as Stripe.InvoicePaymentFailedEvent
}
