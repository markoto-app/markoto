import { describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { cancelSandboxSubscriptions, checkSandboxKey } from '../../../server/utils/billing/sandboxSubscriptions'

// The staging database reset ends every live subscription of the Stripe
// SANDBOX, so the wiped rows leave nothing billing behind. It must never
// run against a live account, never refund (a refund mails the operator),
// and must be safe to run twice.

async function* items<T>(list: T[]): AsyncGenerator<T> {
  for (const item of list) yield item
}

function sub(id: string, status: string, over: Record<string, unknown> = {}): Stripe.Subscription {
  return { id, status, livemode: false, metadata: {}, test_clock: null, ...over } as unknown as Stripe.Subscription
}

function fakeStripe(byStatus: Record<string, Stripe.Subscription[]>, cancelError: (id: string) => unknown = () => null) {
  const list = vi.fn((params: Stripe.SubscriptionListParams) => items(byStatus[params.status as string] ?? []))
  const cancel = vi.fn(async (id: string) => {
    const err = cancelError(id)
    if (err) throw err
    return { id, status: 'canceled' }
  })
  const refund = vi.fn()
  const stripe = { subscriptions: { list, cancel }, refunds: { create: refund } } as unknown as Stripe
  return { stripe, list, cancel, refund }
}

describe('checkSandboxKey', () => {
  it.each([
    ['sk_live_abc', 'live'],
    ['rk_live_abc', 'live'],
    ['  sk_live_abc  ', 'live'],
    ['pk_test_abc', 'unrecognised'],
    ['whsec_abc', 'unrecognised'],
    ['abc', 'unrecognised'],
    ['', 'missing'],
    [null, 'missing'],
    [undefined, 'missing']
  ])('%s is refused (%s)', (key, reason) => {
    expect(checkSandboxKey(key)).toEqual({ ok: false, reason })
  })

  it.each(['sk_test_abc', 'rk_test_abc'])('%s is a sandbox key', (key) => {
    expect(checkSandboxKey(key)).toEqual({ ok: true })
  })
})

describe('cancelSandboxSubscriptions', () => {
  it('cancels every active, trialing and past-due subscription at once, without proration or refund', async () => {
    const f = fakeStripe({
      active: [sub('sub_a1', 'active'), sub('sub_a2', 'active')],
      trialing: [sub('sub_t', 'trialing')],
      past_due: [sub('sub_p', 'past_due')]
    })
    expect(await cancelSandboxSubscriptions(f.stripe)).toEqual({ seen: 4, cancelled: 4, alreadyEnded: 0, skipped: 0 })
    expect(f.list.mock.calls.map(c => c[0])).toEqual([
      { status: 'active', limit: 100 },
      { status: 'trialing', limit: 100 },
      { status: 'past_due', limit: 100 }
    ])
    for (const id of ['sub_a1', 'sub_a2', 'sub_t', 'sub_p']) {
      expect(f.cancel).toHaveBeenCalledWith(id, { prorate: false, invoice_now: false })
    }
    expect(f.refund).not.toHaveBeenCalled()
  })

  it('leaves the CI test suite\'s subscriptions and anything in live mode alone', async () => {
    const f = fakeStripe({
      active: [
        sub('sub_suite', 'active', { metadata: { markoto_test_run: 'run1' } }),
        sub('sub_clock', 'active', { test_clock: 'clock_1' }),
        sub('sub_live', 'active', { livemode: true }),
        sub('sub_staging', 'active')
      ]
    })
    expect(await cancelSandboxSubscriptions(f.stripe)).toEqual({ seen: 4, cancelled: 1, alreadyEnded: 0, skipped: 3 })
    expect(f.cancel.mock.calls.map(c => c[0])).toEqual(['sub_staging'])
  })

  it('is idempotent: one ended in the meantime counts as already ended; nothing left means nothing done', async () => {
    const ended = Object.assign(new Error('already canceled'), { type: 'StripeInvalidRequestError' })
    const f = fakeStripe({ active: [sub('sub_gone', 'active'), sub('sub_x', 'active')] }, id => (id === 'sub_gone' ? ended : null))
    expect(await cancelSandboxSubscriptions(f.stripe)).toEqual({ seen: 2, cancelled: 1, alreadyEnded: 1, skipped: 0 })
    const empty = fakeStripe({})
    expect(await cancelSandboxSubscriptions(empty.stripe)).toEqual({ seen: 0, cancelled: 0, alreadyEnded: 0, skipped: 0 })
    expect(empty.cancel).not.toHaveBeenCalled()
  })

  it('any other Stripe error stops the run', async () => {
    const f = fakeStripe({ active: [sub('sub_a', 'active')] }, () => Object.assign(new Error('down'), { type: 'StripeAPIError' }))
    await expect(cancelSandboxSubscriptions(f.stripe)).rejects.toThrow('down')
  })
})
