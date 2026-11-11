import { describe, it, expect, vi } from 'vitest'
import {
  isLiveSubscriptionStatus,
  findLiveSubscription,
  changeSubscriptionPrice
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

  it('propagates non-missing errors — an outage must NOT look like "no subscription"', async () => {
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
      // …but if payment fails, error with NOTHING changed.
      payment_behavior: 'error_if_incomplete',
      // Upgrading un-schedules a pending cancellation.
      cancel_at_period_end: false
    })
  })

  it('throws when the subscription has no items', async () => {
    const stripe = { subscriptions: { update: vi.fn() } } as unknown as Stripe
    const sub = { id: 'sub_1', items: { data: [] } } as unknown as Stripe.Subscription
    await expect(changeSubscriptionPrice(stripe, sub, 'price_max')).rejects.toThrow(/no items/)
  })
})
