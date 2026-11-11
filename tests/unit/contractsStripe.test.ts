import { describe, it, expect } from 'vitest'
import type Stripe from 'stripe'
import {
  HANDLED_STRIPE_EVENT_TYPES,
  ORDER_SENSITIVE_STRIPE_EVENT_TYPES,
  STRIPE_API_VERSION,
  isOrderSensitiveStripeEvent
} from '~~/shared/contracts/stripe'
import {
  makeCheckoutSessionCompletedEvent,
  makeSubscriptionEvent,
  makeSubscriptionDeletedEvent,
  makeInvoicePaidEvent,
  makeInvoicePaymentFailedEvent
} from '~~/tests/helpers/stripe'

// Contract tests for the Stripe pinning. The point of these is the
// same as the JWT contract tests: catch a drift between
// SDK-typed handler signatures, hand-built test fixtures, and the
// dispatcher's switch table BEFORE it produces a misleading test
// failure or — worse — a silent prod handler that reads `undefined`.
//
// What's pinned where:
//   - `STRIPE_API_VERSION` — the wire-shape pin. Bumping requires
//     coordinated work (see comment in the contract file).
//   - `HANDLED_STRIPE_EVENT_TYPES` — the literal-union of types the
//     dispatcher's switch handles. Adding a type here forces the
//     switch to be updated.
//   - `ORDER_SENSITIVE_STRIPE_EVENT_TYPES` — the subset that may
//     arrive before the binding `checkout.session.completed` and
//     therefore needs the stash branch.
//   - Test event factories — produce Stripe.<X>Event-typed shapes
//     that compile against the SDK, not generic `as unknown as` casts.

describe('STRIPE_API_VERSION', () => {
  it('is a known Stripe API version literal', () => {
    // The Stripe SDK exports `Stripe.LatestApiVersion` as a literal
    // union; the cast in `shared/contracts/stripe.ts` is what lets
    // the constructor accept it. If this test starts failing after
    // an SDK upgrade, that means Stripe deprecated the version we
    // pinned — coordinate the upgrade per the contract file's notes.
    expect(STRIPE_API_VERSION).toBe('2025-01-27.acacia')
  })
})

describe('HANDLED_STRIPE_EVENT_TYPES', () => {
  it('contains exactly the types the dispatcher routes', () => {
    // Hard-coded because a literal union here IS the spec — the
    // dispatcher's switch must agree with this list. If you change
    // either side, this test failing is the canary.
    expect(HANDLED_STRIPE_EVENT_TYPES).toEqual([
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
      'checkout.session.async_payment_failed',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.paid',
      'invoice.payment_failed'
    ])
  })

  it('every order-sensitive type is also a handled type', () => {
    for (const t of ORDER_SENSITIVE_STRIPE_EVENT_TYPES) {
      expect(HANDLED_STRIPE_EVENT_TYPES).toContain(t)
    }
  })

  it('checkout.session.completed is NOT order-sensitive (it is the binding event)', () => {
    expect(ORDER_SENSITIVE_STRIPE_EVENT_TYPES).not.toContain('checkout.session.completed' as never)
  })
})

describe('isOrderSensitiveStripeEvent', () => {
  it('returns true for subscription + invoice events', () => {
    const sub = makeSubscriptionEvent({
      type: 'customer.subscription.created',
      customer: 'cus',
      priceId: 'price_pro'
    })
    expect(isOrderSensitiveStripeEvent(sub)).toBe(true)

    const paid = makeInvoicePaidEvent({
      customer: 'cus',
      subscription: 'sub'
    })
    expect(isOrderSensitiveStripeEvent(paid)).toBe(true)
  })

  it('returns false for checkout.session.completed', () => {
    const event = makeCheckoutSessionCompletedEvent({
      clientReferenceId: '42',
      customer: 'cus'
    })
    expect(isOrderSensitiveStripeEvent(event)).toBe(false)
  })

  it('returns false for unrelated event types', () => {
    const fake = { type: 'charge.refunded', data: { object: {} } } as unknown as Stripe.Event
    expect(isOrderSensitiveStripeEvent(fake)).toBe(false)
  })
})

describe('Stripe event factories: shape assertions', () => {
  it('makeCheckoutSessionCompletedEvent produces a typed checkout event', () => {
    const event = makeCheckoutSessionCompletedEvent({
      sessionId: 'cs_x',
      clientReferenceId: '42',
      customer: 'cus_y',
      subscription: 'sub_z'
    })
    expect(event.type).toBe('checkout.session.completed')
    expect(event.data.object.client_reference_id).toBe('42')
    expect(event.data.object.customer).toBe('cus_y')
    expect(event.data.object.subscription).toBe('sub_z')
  })

  it('makeSubscriptionEvent stamps the price id and item-level period anchors', () => {
    // Item-level period anchors landed in API version 2025-01-27.acacia.
    // The factory MUST stamp them at the item level — handlers read
    // `data.object.items.data[0].current_period_*`.
    const event = makeSubscriptionEvent({
      type: 'customer.subscription.updated',
      customer: 'cus',
      priceId: 'price_pro_abc',
      periodStart: 1700000000,
      periodEnd: 1702678400
    })
    expect(event.type).toBe('customer.subscription.updated')
    const item = (event.data.object as unknown as { items: { data: Array<{ price: { id: string }, current_period_start: number, current_period_end: number }> } }).items.data[0]
    expect(item.price.id).toBe('price_pro_abc')
    expect(item.current_period_start).toBe(1700000000)
    expect(item.current_period_end).toBe(1702678400)
  })

  it('makeSubscriptionDeletedEvent carries customer + id', () => {
    const event = makeSubscriptionDeletedEvent({
      subscriptionId: 'sub_1',
      customer: 'cus_2'
    })
    expect(event.type).toBe('customer.subscription.deleted')
    expect(event.data.object.id).toBe('sub_1')
    expect(event.data.object.customer).toBe('cus_2')
  })

  it('makeInvoicePaidEvent carries period anchors + subscription', () => {
    const event = makeInvoicePaidEvent({
      customer: 'cus',
      subscription: 'sub',
      periodStart: 1234,
      periodEnd: 5678
    })
    expect(event.type).toBe('invoice.paid')
    const inv = event.data.object as unknown as { period_start: number, period_end: number, subscription: string }
    expect(inv.period_start).toBe(1234)
    expect(inv.period_end).toBe(5678)
    expect(inv.subscription).toBe('sub')
  })

  it('makeInvoicePaymentFailedEvent carries attempt_count', () => {
    const event = makeInvoicePaymentFailedEvent({
      customer: 'cus',
      subscription: 'sub',
      attemptCount: 3
    })
    expect(event.type).toBe('invoice.payment_failed')
    const inv = event.data.object as unknown as { attempt_count: number }
    expect(inv.attempt_count).toBe(3)
  })
})
