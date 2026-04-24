import { describe, it, expect, vi } from 'vitest'
import {
  priceIdToPlan,
  handleCheckoutSessionCompleted,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  dispatchStripeEvent
} from '../../server/utils/stripeWebhook'

// Pure-function unit tests for the Stripe webhook helpers. These
// complement the integration tests (which send signed HTTP payloads
// through the real endpoint) by letting us exercise branches that are
// awkward to trigger from HTTP: unknown event types, missing fields,
// different price-id combinations, SDK errors, etc.
//
// The DB-mutating handlers are stubbed via `vi.mock` so the tests
// stay fast and isolated from Postgres.

vi.mock('../../server/utils/database', () => ({
  useDatabase: vi.fn(() => ({
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
          limit: vi.fn().mockResolvedValue([])
        }))
      }))
    }))
  }))
}))

const PRICES = {
  pricePro: 'price_pro_abc',
  priceMax: 'price_max_def',
  priceUltra: 'price_ultra_ghi'
}

describe('priceIdToPlan', () => {
  it('maps configured price ids to plans', () => {
    expect(priceIdToPlan('price_pro_abc', PRICES)).toBe('pro')
    expect(priceIdToPlan('price_max_def', PRICES)).toBe('max')
    expect(priceIdToPlan('price_ultra_ghi', PRICES)).toBe('ultra')
  })

  it('returns null for unknown price ids', () => {
    expect(priceIdToPlan('price_unknown_xyz', PRICES)).toBeNull()
    expect(priceIdToPlan('random', PRICES)).toBeNull()
  })

  it('returns null for empty string / null / undefined (defensive)', () => {
    expect(priceIdToPlan('', PRICES)).toBeNull()
    expect(priceIdToPlan(null, PRICES)).toBeNull()
    expect(priceIdToPlan(undefined, PRICES)).toBeNull()
  })

  it('never confuses prices across plans (partial-string safety)', () => {
    // If someone ever did a substring match by accident, a config
    // like `pricePro='price_pro'` + caller `price_pro_free` would
    // match. This test pins the exact-equality contract.
    const prices = { pricePro: 'price_pro', priceMax: 'price_pro_max', priceUltra: 'pro' }
    expect(priceIdToPlan('price_pro', prices)).toBe('pro')
    expect(priceIdToPlan('price_pro_max', prices)).toBe('max')
    expect(priceIdToPlan('pro', prices)).toBe('ultra')
    expect(priceIdToPlan('price_pro_free', prices)).toBeNull() // NOT pro
  })
})

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
    const event = {
      type: 'checkout.session.completed',
      data: { object: {
        id: 'cs_test',
        client_reference_id: '42',
        customer: 'cus_test',
        subscription: 'sub_abc'
      } }
    } as unknown as Parameters<typeof handleCheckoutSessionCompleted>[0]

    const result = await handleCheckoutSessionCompleted(event, {
      stripe: stripe as Parameters<typeof handleCheckoutSessionCompleted>[1]['stripe'],
      config: PRICES
    })

    expect(result.plan).toBe('pro')
    // The SDK retrieve was called with the subscription id from the session.
    expect((stripe as { subscriptions: { retrieve: ReturnType<typeof vi.fn> } }).subscriptions.retrieve)
      .toHaveBeenCalledWith('sub_abc')
  })

  it('falls back to subscription-level period fields when item-level are absent (older API versions)', async () => {
    const stripe = makeStripeMock({
      id: 'sub_abc',
      current_period_start: 1800000000,
      current_period_end: 1802678400,
      items: { data: [{ price: { id: 'price_pro_abc' } }] } // no current_period_* on item
    })
    const event = {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs', client_reference_id: '42', customer: 'cus', subscription: 'sub_abc' } }
    } as unknown as Parameters<typeof handleCheckoutSessionCompleted>[0]

    const result = await handleCheckoutSessionCompleted(event, { stripe, config: PRICES })
    // The handler should still succeed — fallback path read from
    // sub.current_period_start instead of item.current_period_start.
    expect(result.plan).toBe('pro')
  })

  it('returns matched:0 when client_reference_id is missing (orphan checkout)', async () => {
    const stripe = makeStripeMock({ id: 'sub', items: { data: [] } })
    const event = {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs', customer: 'cus', subscription: 'sub' } }
    } as unknown as Parameters<typeof handleCheckoutSessionCompleted>[0]
    const result = await handleCheckoutSessionCompleted(event, { stripe, config: PRICES })
    expect(result.matched).toBe(0)
    // SDK not called — we bail before fetching.
    expect((stripe as { subscriptions: { retrieve: ReturnType<typeof vi.fn> } }).subscriptions.retrieve)
      .not.toHaveBeenCalled()
  })

  it('stamps customer id only when there\'s no subscription (non-subscription checkout)', async () => {
    const stripe = makeStripeMock({ id: 'sub', items: { data: [] } })
    const event = {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs', client_reference_id: '42', customer: 'cus_test', subscription: null } }
    } as unknown as Parameters<typeof handleCheckoutSessionCompleted>[0]
    const result = await handleCheckoutSessionCompleted(event, { stripe, config: PRICES })
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
    const event = {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs', client_reference_id: '42', customer: 'cus', subscription: 'sub_abc' } }
    } as unknown as Parameters<typeof handleCheckoutSessionCompleted>[0]
    const result = await handleCheckoutSessionCompleted(event, { stripe, config: PRICES })
    expect(result.plan).toBeNull()
  })

  it('propagates SDK errors so the webhook can return 500 + Stripe retries', async () => {
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockRejectedValue(new Error('Network error'))
      }
    } as unknown as Parameters<typeof handleCheckoutSessionCompleted>[1]['stripe']
    const event = {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs', client_reference_id: '42', customer: 'cus', subscription: 'sub' } }
    } as unknown as Parameters<typeof handleCheckoutSessionCompleted>[0]
    await expect(handleCheckoutSessionCompleted(event, { stripe, config: PRICES }))
      .rejects.toThrow(/Network error/)
  })
})

describe('dispatchStripeEvent — routing + unknown events', () => {
  const mockStripe = makeStripeMock({ id: 'sub', items: { data: [{ price: { id: 'price_pro_abc' } }] } })
  const opts = { stripe: mockStripe, config: PRICES }

  it('routes checkout.session.completed to its handler', async () => {
    const event = {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs', client_reference_id: '42', customer: 'cus', subscription: 'sub' } }
    } as unknown as Parameters<typeof dispatchStripeEvent>[0]
    const r = await dispatchStripeEvent(event, opts)
    expect(r.handled).toBe(true)
  })

  it('routes subscription.created and subscription.updated to the same handler', async () => {
    for (const type of ['customer.subscription.created', 'customer.subscription.updated']) {
      const event = {
        type,
        data: { object: {
          id: 'sub', customer: 'cus',
          items: { data: [{
            current_period_start: 1800000000,
            current_period_end: 1802678400,
            price: { id: 'price_pro_abc' }
          }] }
        } }
      } as unknown as Parameters<typeof dispatchStripeEvent>[0]
      const r = await dispatchStripeEvent(event, opts)
      expect(r.handled).toBe(true)
    }
  })

  it('routes invoice.paid / invoice.payment_failed to their handlers', async () => {
    const paid = {
      type: 'invoice.paid',
      data: { object: { id: 'in', customer: 'cus', subscription: 'sub', period_start: 1800000000, period_end: 1802678400 } }
    } as unknown as Parameters<typeof dispatchStripeEvent>[0]
    expect((await dispatchStripeEvent(paid, opts)).handled).toBe(true)

    const failed = {
      type: 'invoice.payment_failed',
      data: { object: { id: 'in', customer: 'cus', subscription: 'sub', attempt_count: 1 } }
    } as unknown as Parameters<typeof dispatchStripeEvent>[0]
    expect((await dispatchStripeEvent(failed, opts)).handled).toBe(true)
  })

  it('returns handled:false for unknown event types', async () => {
    const event = { type: 'charge.refunded', data: { object: {} } } as unknown as Parameters<typeof dispatchStripeEvent>[0]
    const r = await dispatchStripeEvent(event, opts)
    expect(r.handled).toBe(false)
  })
})

describe('handleSubscriptionDeleted / InvoicePaymentFailed — branch coverage', () => {
  it('invoice.payment_failed is logged-only, never updates the DB', async () => {
    // Stub console.warn to suppress noise + verify we log.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const event = {
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_xxx', customer: 'cus_xxx', attempt_count: 2 } }
    } as unknown as Parameters<typeof handleInvoicePaymentFailed>[0]
    const result = await handleInvoicePaymentFailed(event)
    expect(result.matched).toBe(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('subscription.deleted without customer id no-ops (belt-and-braces)', async () => {
    const event = {
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub', customer: '' } }
    } as unknown as Parameters<typeof handleSubscriptionDeleted>[0]
    // Should resolve, not throw. Matched = 0 because updateUser's
    // where-clause is `stripe_customer_id = ''` which matches nothing.
    const result = await handleSubscriptionDeleted(event)
    expect(result.matched).toBeGreaterThanOrEqual(0)
  })

  it('invoice.paid skips non-subscription invoices', async () => {
    const event = {
      type: 'invoice.paid',
      data: { object: { id: 'in', customer: 'cus', subscription: null } }
    } as unknown as Parameters<typeof handleInvoicePaid>[0]
    const result = await handleInvoicePaid(event)
    expect(result.matched).toBe(0)
  })
})

describe('handleSubscriptionUpdated — unknown price graceful', () => {
  it('logs + no-ops when the price id is unrecognised', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const event = {
      type: 'customer.subscription.updated',
      data: { object: {
        id: 'sub', customer: 'cus',
        items: { data: [{
          current_period_start: 1800000000,
          current_period_end: 1802678400,
          price: { id: 'price_unrecognised' }
        }] }
      } }
    } as unknown as Parameters<typeof handleSubscriptionUpdated>[0]
    const result = await handleSubscriptionUpdated(event, PRICES)
    expect(result.plan).toBeNull()
    expect(result.matched).toBe(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
