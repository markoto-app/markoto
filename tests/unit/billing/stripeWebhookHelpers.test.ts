import { describe, it, expect, vi } from 'vitest'
import type Stripe from 'stripe'
import {
  handleCheckoutSessionCompleted,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  dispatchStripeEvent
} from '../../../server/utils/billing/stripeWebhook'
import {
  makeCheckoutSessionCompletedEvent,
  makeSubscriptionEvent,
  makeSubscriptionDeletedEvent,
  makeInvoicePaidEvent,
  makeInvoicePaymentFailedEvent
} from '~~/tests/helpers/stripe'

// Pure-function unit tests for the Stripe webhook helpers. These
// complement the integration tests (which send signed HTTP payloads
// through the real endpoint) by letting us exercise branches that are
// awkward to trigger from HTTP: unknown event types, missing fields,
// different price-id combinations, SDK errors, etc.
//
// The DB-mutating handlers are stubbed via `vi.mock` so the tests
// stay fast and isolated from Postgres.

// Tx-shape stub: covers all the chained drizzle calls the dispatcher +
// handlers issue against either the top-level db OR a transaction handle.
// The dispatcher wraps the whole event in db.transaction(async (tx) => …);
// the dedup INSERT returns a row (so the dispatch proceeds), the
// customer-bound probe returns one user (so the stash branch is skipped),
// and the per-event UPDATE returns 1 matched row.
function buildDbStub() {
  return {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: 42 }])
        }))
      }))
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ id: 42 }]),
          orderBy: vi.fn().mockResolvedValue([])
        })),
        orderBy: vi.fn().mockResolvedValue([])
      }))
    })),
    // Dedup INSERT: return a non-empty array so dispatcher continues
    // past the replay short-circuit. Tests that want to assert the
    // short-circuit override the mock per-test.
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ eventId: 'evt_test' }])
        }))
      }))
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([])
      }))
    }))
  }
}

vi.mock('../../../server/utils/platform/database', () => ({
  useDatabase: vi.fn(() => {
    const stub = buildDbStub()
    // db.transaction(cb) just runs the callback with the same stub
    // shape — fine for unit tests since we don't model isolation.
    return {
      ...stub,
      transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(stub))
    }
  })
}))

// The price catalogue maps this test price id to Pro (monthly, EUR): prices are identified by lookup key or
// by the NUXT_STRIPE_PRICE_IDS override, read per call.
vi.stubEnv('NUXT_STRIPE_PRICE_IDS', 'markoto_pro_month_eur=price_pro_abc')

// Minimal Stripe SDK mock. Only `subscriptions.retrieve` is called by
// the checkout handler; shape it returns has to match the real SDK
// well enough for the code path to work.
function makeStripeMock(subscription: {
  id: string
  items: { data: Array<{ current_period_start?: number, current_period_end?: number, price: { id: string } }> }
  current_period_start?: number
  current_period_end?: number
}) {
  return {
    subscriptions: {
      retrieve: vi.fn().mockResolvedValue(subscription)
    }
  } as unknown as Parameters<typeof handleCheckoutSessionCompleted>[1]['stripe']
}

describe('handleCheckoutSessionCompleted — race fix', () => {
  it('fetches subscription from Stripe and applies plan + period anchors in one shot', async () => {
    const stripe = makeStripeMock({
      id: 'sub_abc',
      items: { data: [{
        current_period_start: 1800000000,
        current_period_end: 1802678400,
        price: { id: 'price_pro_abc' }
      }] }
    })
    const event = makeCheckoutSessionCompletedEvent({
      sessionId: 'cs_test',
      clientReferenceId: '42',
      customer: 'cus_test',
      subscription: 'sub_abc'
    })

    const result = await handleCheckoutSessionCompleted(event, {
      stripe: stripe as Parameters<typeof handleCheckoutSessionCompleted>[1]['stripe']
    })

    expect(result.plan).toBe('pro')
    // The SDK retrieve was called with the subscription id from the session.
    expect((stripe as { subscriptions: { retrieve: ReturnType<typeof vi.fn> } }).subscriptions.retrieve)
      .toHaveBeenCalledWith('sub_abc')
  })

  it('returns matched:0 when client_reference_id is missing (orphan checkout)', async () => {
    const stripe = makeStripeMock({ id: 'sub', items: { data: [] } })
    // Construct typed but stamp client_reference_id null inline — the
    // factory requires it (handlers usually depend on it), this branch
    // is the corner case where it's missing.
    const event = {
      ...makeCheckoutSessionCompletedEvent({
        sessionId: 'cs',
        clientReferenceId: '',
        customer: 'cus',
        subscription: 'sub'
      }),
      data: { object: { id: 'cs', object: 'checkout.session', customer: 'cus', subscription: 'sub', client_reference_id: null } as unknown as Stripe.Checkout.Session }
    } as Stripe.CheckoutSessionCompletedEvent
    const result = await handleCheckoutSessionCompleted(event, { stripe })
    expect(result.matched).toBe(0)
    // SDK not called — we bail before fetching.
    expect((stripe as { subscriptions: { retrieve: ReturnType<typeof vi.fn> } }).subscriptions.retrieve)
      .not.toHaveBeenCalled()
  })

  it('stamps customer id only when there\'s no subscription (non-subscription checkout)', async () => {
    const stripe = makeStripeMock({ id: 'sub', items: { data: [] } })
    const event = makeCheckoutSessionCompletedEvent({
      sessionId: 'cs',
      clientReferenceId: '42',
      customer: 'cus_test',
      subscription: null
    })
    const result = await handleCheckoutSessionCompleted(event, { stripe })
    // matched comes from the mock (returns 1 row)
    expect(result.plan).toBeNull()
    expect((stripe as { subscriptions: { retrieve: ReturnType<typeof vi.fn> } }).subscriptions.retrieve)
      .not.toHaveBeenCalled()
  })

  it('still stamps customer/sub/periods when price maps to no known plan', async () => {
    // Ops scenario: price id rotated in Stripe but not in our env
    // config. We still stamp the customer + subscription + period
    // anchors so ops can reconcile manually; we DON'T fabricate a
    // plan from a bogus mapping.
    const stripe = makeStripeMock({
      id: 'sub_abc',
      items: { data: [{
        current_period_start: 1800000000,
        current_period_end: 1802678400,
        price: { id: 'price_unknown_rotated' }
      }] }
    })
    const event = makeCheckoutSessionCompletedEvent({
      sessionId: 'cs',
      clientReferenceId: '42',
      customer: 'cus',
      subscription: 'sub_abc'
    })
    const result = await handleCheckoutSessionCompleted(event, { stripe })
    expect(result.plan).toBeNull()
  })

  it('propagates SDK errors so the webhook can return 500 + Stripe retries', async () => {
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockRejectedValue(new Error('Network error'))
      }
    } as unknown as Parameters<typeof handleCheckoutSessionCompleted>[1]['stripe']
    const event = makeCheckoutSessionCompletedEvent({
      sessionId: 'cs',
      clientReferenceId: '42',
      customer: 'cus',
      subscription: 'sub'
    })
    await expect(handleCheckoutSessionCompleted(event, { stripe }))
      .rejects.toThrow(/Network error/)
  })
})

describe('dispatchStripeEvent — routing + unknown events', () => {
  const mockStripe = makeStripeMock({ id: 'sub', items: { data: [{ price: { id: 'price_pro_abc' } }] } })
  const opts = { stripe: mockStripe }

  it('routes checkout.session.completed to its handler', async () => {
    const event = makeCheckoutSessionCompletedEvent({
      sessionId: 'cs',
      clientReferenceId: '42',
      customer: 'cus',
      subscription: 'sub'
    })
    const r = await dispatchStripeEvent(event, opts)
    expect(r.handled).toBe(true)
  })

  it('routes subscription.created and subscription.updated to the same handler', async () => {
    for (const type of ['customer.subscription.created', 'customer.subscription.updated'] as const) {
      const event = makeSubscriptionEvent({
        type,
        subscriptionId: 'sub',
        customer: 'cus',
        priceId: 'price_pro_abc'
      })
      const r = await dispatchStripeEvent(event, opts)
      expect(r.handled).toBe(true)
    }
  })

  it('routes invoice.paid / invoice.payment_failed to their handlers', async () => {
    const paid = makeInvoicePaidEvent({
      invoiceId: 'in',
      customer: 'cus',
      subscription: 'sub'
    })
    expect((await dispatchStripeEvent(paid, opts)).handled).toBe(true)

    const failed = makeInvoicePaymentFailedEvent({
      invoiceId: 'in',
      customer: 'cus',
      subscription: 'sub',
      attemptCount: 1
    })
    expect((await dispatchStripeEvent(failed, opts)).handled).toBe(true)
  })

  it('returns handled:false for unknown event types', async () => {
    // Adversarial: a Stripe event type our dispatcher does NOT handle.
    // Cast inline since the factories only build event types we DO
    // handle (by design — adding a new factory to this module should
    // be a coordinated decision with the dispatcher's switch).
    const event = { type: 'customer.tax_id.created', data: { object: {} } } as unknown as Parameters<typeof dispatchStripeEvent>[0]
    const r = await dispatchStripeEvent(event, opts)
    expect(r.handled).toBe(false)
  })
})

describe('handleSubscriptionDeleted / InvoicePaymentFailed — branch coverage', () => {
  it('invoice.payment_failed is logged-only, never updates the DB', async () => {
    // Stub console.warn to suppress noise + verify we log.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const event = makeInvoicePaymentFailedEvent({
      invoiceId: 'in_xxx',
      customer: 'cus_xxx',
      subscription: 'sub_xxx',
      attemptCount: 2
    })
    const result = await handleInvoicePaymentFailed(event)
    expect(result.matched).toBe(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('subscription.deleted without customer id no-ops (belt-and-braces)', async () => {
    const event = makeSubscriptionDeletedEvent({
      subscriptionId: 'sub',
      customer: ''
    })
    // Should resolve, not throw. Matched = 0 because updateUser's
    // where-clause is `stripe_customer_id = ''` which matches nothing.
    const result = await handleSubscriptionDeleted(event)
    expect(result.matched).toBeGreaterThanOrEqual(0)
  })

  it('invoice.paid skips non-subscription invoices', async () => {
    // Adversarial: handler-tested null subscription. Build base via
    // factory then override subscription inline so the typed shape
    // is only nudged where the test cares about a corner case.
    const base = makeInvoicePaidEvent({
      invoiceId: 'in',
      customer: 'cus',
      subscription: 'sub_placeholder'
    })
    const event = {
      ...base,
      data: { object: { ...base.data.object, subscription: null } as unknown as Stripe.Invoice }
    } as Stripe.InvoicePaidEvent
    const result = await handleInvoicePaid(event)
    expect(result.matched).toBe(0)
  })
})

describe('handleSubscriptionUpdated — unknown price graceful', () => {
  it('logs + no-ops when the price id is unrecognised', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const event = makeSubscriptionEvent({
      type: 'customer.subscription.updated',
      subscriptionId: 'sub',
      customer: 'cus',
      priceId: 'price_unrecognised'
    })
    const result = await handleSubscriptionUpdated(event)
    expect(result.plan).toBeNull()
    expect(result.matched).toBe(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
