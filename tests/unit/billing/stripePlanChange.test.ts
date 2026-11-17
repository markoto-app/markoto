import { describe, it, expect, vi } from 'vitest'
import {
  isLiveSubscriptionStatus,
  findLiveSubscription,
  changeSubscriptionPrice,
  pendingPayment,
  paymentPendingError
} from '../../../server/utils/billing/stripePlanChange'
import type Stripe from 'stripe'

// The checkout endpoint's double-subscription guard. The invariant
// these tests pin: a user with a LIVE subscription must never reach
// `checkout.sessions.create` (which would open a second concurrent
// subscription); a user with a terminal/absent one must.

describe('isLiveSubscriptionStatus', () => {
  it('treats billing-active statuses as live', () => {
    for (const s of ['active', 'trialing', 'past_due', 'unpaid', 'incomplete']) {
      expect(isLiveSubscriptionStatus(s), s).toBe(true)
    }
  })

  it('treats terminal statuses as gone (fresh Checkout is correct)', () => {
    for (const s of ['canceled', 'incomplete_expired', 'paused', 'nonsense']) {
      expect(isLiveSubscriptionStatus(s), s).toBe(false)
    }
  })
})

function stripeWith(retrieve: (id: string) => Promise<unknown>): Stripe {
  return { subscriptions: { retrieve, update: vi.fn() } } as unknown as Stripe
}

describe('findLiveSubscription', () => {
  it('returns null without a recorded subscription id (no Stripe call)', async () => {
    const retrieve = vi.fn()
    expect(await findLiveSubscription(stripeWith(retrieve), null)).toBeNull()
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('returns the subscription when its status is live', async () => {
    const sub = { id: 'sub_1', status: 'active' }
    const stripe = stripeWith(async () => sub)
    expect(await findLiveSubscription(stripe, 'sub_1')).toBe(sub)
  })

  it('returns null for a terminal status', async () => {
    const stripe = stripeWith(async () => ({ id: 'sub_1', status: 'canceled' }))
    expect(await findLiveSubscription(stripe, 'sub_1')).toBeNull()
  })

  it('returns null when Stripe reports the subscription missing', async () => {
    const stripe = stripeWith(async () => {
      throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' })
    })
    expect(await findLiveSubscription(stripe, 'sub_gone')).toBeNull()
  })

  it('propagates non-missing errors: an outage must NOT look like "no subscription"', async () => {
    const stripe = stripeWith(async () => {
      throw Object.assign(new Error('rate limited'), { code: 'rate_limit' })
    })
    await expect(findLiveSubscription(stripe, 'sub_1')).rejects.toThrow('rate limited')
  })
})

describe('changeSubscriptionPrice', () => {
  it('swaps the existing item to the new price with safe payment semantics', async () => {
    const update = vi.fn(async () => ({ id: 'sub_1' }))
    const stripe = { subscriptions: { update } } as unknown as Stripe
    const sub = { id: 'sub_1', items: { data: [{ id: 'si_9' }] } } as unknown as Stripe.Subscription

    await changeSubscriptionPrice(stripe, sub, 'price_max')

    expect(update).toHaveBeenCalledWith('sub_1', {
      items: [{ id: 'si_9', price: 'price_max' }],
      // Charge the prorated delta NOW (budget is available now)…
      proration_behavior: 'always_invoice',
      // …but apply the change only once that invoice is paid.
      payment_behavior: 'pending_if_incomplete',
      // The invoice to pay when the payment needs the buyer.
      expand: ['latest_invoice'],
      // Upgrading un-schedules a pending cancellation.
      cancel_at_period_end: false
    })
  })

  it('keeps the seat count when given one', async () => {
    const update = vi.fn(async () => ({ id: 'sub_1' }))
    const stripe = { subscriptions: { update } } as unknown as Stripe
    const sub = { id: 'sub_1', items: { data: [{ id: 'si_9' }] } } as unknown as Stripe.Subscription
    await changeSubscriptionPrice(stripe, sub, 'price_team', 7)
    expect(update).toHaveBeenCalledWith('sub_1', expect.objectContaining({ items: [{ id: 'si_9', price: 'price_team', quantity: 7 }] }))
  })

  it('throws when the subscription has no items', async () => {
    const stripe = { subscriptions: { update: vi.fn() } } as unknown as Stripe
    const sub = { id: 'sub_1', items: { data: [] } } as unknown as Stripe.Subscription
    await expect(changeSubscriptionPrice(stripe, sub, 'price_max')).rejects.toThrow(/no items/)
  })
})

describe('pendingPayment', () => {
  it('is null when Stripe applied the change (paid at once)', () => {
    const sub = { id: 'sub_1', pending_update: null, latest_invoice: { id: 'in_1', hosted_invoice_url: 'https://invoice.stripe.com/i/x' } } as unknown as Stripe.Subscription
    expect(pendingPayment(sub)).toBeNull()
  })

  it('reports a change waiting for its payment with the invoice page to pay it', () => {
    const sub = {
      id: 'sub_1',
      pending_update: { expires_at: 1_800_000_000, subscription_items: [{ id: 'si_9', price: 'price_max' }] },
      latest_invoice: { id: 'in_1', hosted_invoice_url: 'https://invoice.stripe.com/i/x' }
    } as unknown as Stripe.Subscription
    expect(pendingPayment(sub, new Date(1_700_000_000_000))).toEqual({ paymentUrl: 'https://invoice.stripe.com/i/x' })
  })

  it('has no link when the invoice was not expanded', () => {
    const sub = { id: 'sub_1', pending_update: { expires_at: 1_800_000_000 }, latest_invoice: 'in_1' } as unknown as Stripe.Subscription
    expect(pendingPayment(sub, new Date(1_700_000_000_000))).toEqual({ paymentUrl: null })
  })

  it('an expired pending update holds nothing (Stripe dropped it; stripe-mock always returns one)', () => {
    const sub = { id: 'sub_1', pending_update: { expires_at: 833_811_170 }, latest_invoice: 'in_1' } as unknown as Stripe.Subscription
    expect(pendingPayment(sub)).toBeNull()
  })
})

describe('paymentPendingError', () => {
  it('is a 402 billing/payment-pending with the pay link as recovery', () => {
    const e = paymentPendingError({ paymentUrl: 'https://invoice.stripe.com/i/x' })
    expect(e).toMatchObject({
      statusCode: 402,
      data: { code: 'billing/payment-pending', recovery: { kind: 'link', href: 'https://invoice.stripe.com/i/x', labelKey: 'billing.completePayment' } }
    })
  })

  it('carries no recovery without a link', () => {
    const e = paymentPendingError({ paymentUrl: null })
    expect(e).toMatchObject({ statusCode: 402, data: { code: 'billing/payment-pending' } })
    expect((e.data as Record<string, unknown>).recovery).toBeUndefined()
  })
})
