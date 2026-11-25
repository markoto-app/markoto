import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { captureLogs } from '../../helpers/logs'
import { makeCheckoutSessionCompletedEvent } from '~~/tests/helpers/stripe'
import type { DeferredAfterCommit } from '../../../server/utils/billing/stripeEvents/types'

// A second personal Pro checkout that completes while the user already
// has a live subscription (two tabs, a stale Checkout page): the tracked
// subscription stays, the new one is cancelled and its first invoice
// refunded. A tracked subscription that is ending or ended gives way to
// the new one. The user row is in memory; the locked read's SQL is pinned
// by `tests/repos/userBillingTrackedSubscription.test.ts`.

const USER = 42
const TRACKED = 'sub_tracked'
const NEW = 'sub_new'

const { row, repo, keys } = vi.hoisted(() => {
  const row = { stripeCustomerId: 'cus_pro' as string | null, stripeSubscriptionId: 'sub_tracked' as string | null, plan: 'pro' as string }
  return {
    row,
    repo: {
      lockTrackedSubscriptionOfUser: vi.fn(async () => row.stripeSubscriptionId),
      updateUserBilling: vi.fn(async (_by: unknown, opts: { set: Record<string, unknown> }) => {
        Object.assign(row, opts.set)
        return 1
      })
    },
    keys: { updateUserKeyBudget: vi.fn() }
  }
})

vi.mock('../../../server/repos/userBilling', () => repo)
vi.mock('../../../server/utils/litellm/userKeys', () => keys)

const { handleCheckoutSessionCompleted } = await import('../../../server/utils/billing/stripeEvents/checkoutCompleted')

const logs = captureLogs()

async function* items<T>(list: T[]): AsyncGenerator<T> {
  for (const item of list) yield item
}

function subscription(id: string, status: string, extra: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id,
    status,
    customer: 'cus_pro',
    cancel_at: null,
    cancel_at_period_end: false,
    latest_invoice: `in_${id}`,
    items: { data: [{ price: { id: 'price_pro_month' }, current_period_start: 1_800_000_000, current_period_end: 1_802_678_400 }] },
    ...extra
  } as unknown as Stripe.Subscription
}

function fakeStripe(subs: Stripe.Subscription[], opts: { missing?: string[] } = {}) {
  const byId = new Map(subs.map(s => [s.id, s]))
  const retrieve = vi.fn(async (id: string) => {
    if (opts.missing?.includes(id)) throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' })
    const sub = byId.get(id)
    if (!sub) throw new Error(`unexpected retrieve ${id}`)
    return sub
  })
  const cancel = vi.fn().mockResolvedValue({})
  const refund = vi.fn().mockResolvedValue({})
  const stripe = {
    subscriptions: { retrieve, cancel },
    refunds: { create: refund },
    invoices: { retrieve: vi.fn(async (id: string) => ({ id, status: 'paid' })) },
    invoicePayments: { list: vi.fn(() => items([{ payment: { type: 'payment_intent', payment_intent: 'pi_new' } }])) }
  } as unknown as Stripe
  return { stripe, retrieve, cancel, refund }
}

function checkout(subscriptionId = NEW): Stripe.CheckoutSessionCompletedEvent {
  return makeCheckoutSessionCompletedEvent({ sessionId: 'cs_second', clientReferenceId: String(USER), customer: 'cus_pro', subscription: subscriptionId })
}

beforeEach(() => {
  vi.stubEnv('NUXT_STRIPE_PRICE_IDS', 'markoto_pro_month_eur=price_pro_month')
  Object.assign(row, { stripeCustomerId: 'cus_pro', stripeSubscriptionId: TRACKED, plan: 'pro' })
  repo.updateUserBilling.mockClear()
  repo.lockTrackedSubscriptionOfUser.mockClear()
  keys.updateUserKeyBudget.mockReset()
})

describe('checkout.session.completed while the user tracks another subscription', () => {
  it('a live tracked subscription stays; the new one is cancelled without proration and refunded', async () => {
    const f = fakeStripe([subscription(TRACKED, 'active'), subscription(NEW, 'active')])
    const deferred: DeferredAfterCommit = []
    const result = await handleCheckoutSessionCompleted(checkout(), { stripe: f.stripe, deferAfterCommit: deferred })

    expect(result).toEqual({ matched: 0, plan: null })
    expect(row.stripeSubscriptionId).toBe(TRACKED)
    expect(repo.updateUserBilling).not.toHaveBeenCalled()
    expect(deferred).toHaveLength(0)
    expect(f.cancel).toHaveBeenCalledWith(NEW, { prorate: false, invoice_now: false })
    expect(f.refund).toHaveBeenCalledWith(
      { payment_intent: 'pi_new', metadata: { reason: 'duplicate_personal_subscription', user_id: '42', subscription_id: NEW } },
      { idempotencyKey: 'markoto-duplicate-subscription-refund-pi_new' }
    )
    expect(logs.find('warn', 'duplicate subscription cancelled')).toMatchObject({ component: 'billing', subscriptionId: NEW, userId: '42', refunded: 1 })
  })

  it.each(['trialing', 'past_due'])('a %s tracked subscription is kept too', async (status) => {
    const f = fakeStripe([subscription(TRACKED, status), subscription(NEW, 'active')])
    expect(await handleCheckoutSessionCompleted(checkout(), { stripe: f.stripe })).toEqual({ matched: 0, plan: null })
    expect(f.cancel).toHaveBeenCalledWith(NEW, expect.anything())
    expect(row.stripeSubscriptionId).toBe(TRACKED)
  })

  it('a redelivery cancels nothing twice and refunds under the same idempotency key', async () => {
    const f = fakeStripe([subscription(TRACKED, 'active'), subscription(NEW, 'canceled')])
    expect(await handleCheckoutSessionCompleted(checkout(), { stripe: f.stripe })).toEqual({ matched: 0, plan: null })
    expect(f.cancel).not.toHaveBeenCalled()
    expect(f.refund).toHaveBeenCalledWith(expect.anything(), { idempotencyKey: 'markoto-duplicate-subscription-refund-pi_new' })
    expect(row.stripeSubscriptionId).toBe(TRACKED)
  })

  it.each([
    ['cancelled to the period end', subscription(TRACKED, 'active', { cancel_at_period_end: true })],
    ['cancelled at a set date', subscription(TRACKED, 'active', { cancel_at: 1_802_678_400 })],
    ['ended', subscription(TRACKED, 'canceled')],
    ['never paid', subscription(TRACKED, 'incomplete')],
    ['unpaid', subscription(TRACKED, 'unpaid')]
  ])('a tracked subscription that is %s gives way: the new one is bound', async (_label, tracked) => {
    const f = fakeStripe([tracked, subscription(NEW, 'active')])
    const deferred: DeferredAfterCommit = []
    expect(await handleCheckoutSessionCompleted(checkout(), { stripe: f.stripe, deferAfterCommit: deferred })).toEqual({ matched: 1, plan: 'pro' })
    expect(row).toMatchObject({ stripeSubscriptionId: NEW, plan: 'pro' })
    expect(f.cancel).not.toHaveBeenCalled()
    expect(f.refund).not.toHaveBeenCalled()
    for (const job of deferred) await job()
    expect(keys.updateUserKeyBudget).toHaveBeenCalledWith(USER, 'pro')
  })

  it('a tracked subscription Stripe no longer has gives way', async () => {
    const f = fakeStripe([subscription(NEW, 'active')], { missing: [TRACKED] })
    expect(await handleCheckoutSessionCompleted(checkout(), { stripe: f.stripe })).toEqual({ matched: 1, plan: 'pro' })
    expect(row.stripeSubscriptionId).toBe(NEW)
  })

  it('a Stripe outage while reading the tracked subscription fails the webhook (Stripe retries)', async () => {
    const f = fakeStripe([subscription(NEW, 'active')])
    f.retrieve.mockImplementation(async (id: string) => {
      if (id === TRACKED) throw new Error('Stripe unavailable')
      return subscription(NEW, 'active')
    })
    await expect(handleCheckoutSessionCompleted(checkout(), { stripe: f.stripe })).rejects.toThrow(/Stripe unavailable/)
    expect(repo.updateUserBilling).not.toHaveBeenCalled()
  })

  it('the redelivered checkout of the tracked subscription binds it again (no Stripe lookup of a duplicate)', async () => {
    const f = fakeStripe([subscription(TRACKED, 'active')])
    expect(await handleCheckoutSessionCompleted(checkout(TRACKED), { stripe: f.stripe })).toEqual({ matched: 1, plan: 'pro' })
    expect(f.retrieve).toHaveBeenCalledTimes(1)
    expect(f.cancel).not.toHaveBeenCalled()
  })

  it('a first checkout (nothing tracked) binds as before', async () => {
    row.stripeSubscriptionId = null
    const f = fakeStripe([subscription(NEW, 'active')])
    expect(await handleCheckoutSessionCompleted(checkout(), { stripe: f.stripe })).toEqual({ matched: 1, plan: 'pro' })
    expect(row.stripeSubscriptionId).toBe(NEW)
  })

  it('an ended subscription the row does not track is not bound (a late redelivery)', async () => {
    row.stripeSubscriptionId = null
    const f = fakeStripe([subscription(NEW, 'canceled')])
    expect(await handleCheckoutSessionCompleted(checkout(), { stripe: f.stripe })).toEqual({ matched: 0, plan: null })
    expect(repo.updateUserBilling).not.toHaveBeenCalled()
    expect(f.cancel).not.toHaveBeenCalled()
    expect(logs.find('info', 'ignoring checkout of an ended subscription')).toMatchObject({ subscriptionId: NEW, userId: USER })
  })
})
