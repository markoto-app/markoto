import { describe, it, expect, vi } from 'vitest'
import type Stripe from 'stripe'
import { cancelDuplicateWorkspaceSubscription, expireOpenWorkspaceCheckouts } from '../../server/utils/workspaceStripe'

// Two completed Checkouts for one workspace (two admins, or two tabs):
// the newest open Checkout is the only one that can be paid, and a
// duplicate subscription that slips through is cancelled + refunded.

async function* items<T>(list: T[]): AsyncGenerator<T> {
  for (const item of list) yield item
}

function fakeStripe(opts: { payments?: Array<{ payment_intent?: string }>, sessions?: Array<{ id: string, mode: string }>, refundFails?: boolean } = {}) {
  const cancel = vi.fn().mockResolvedValue({})
  const refund = vi.fn(async () => {
    if (opts.refundFails) throw new Error('refund failed')
    return {}
  })
  const listPayments = vi.fn(() => items((opts.payments ?? []).map(p => ({ payment: { type: 'payment_intent', ...p } }))))
  const expire = vi.fn().mockResolvedValue({})
  const listSessions = vi.fn(() => items(opts.sessions ?? []))
  const stripe = {
    subscriptions: { cancel },
    refunds: { create: refund },
    invoicePayments: { list: listPayments },
    checkout: { sessions: { list: listSessions, expire } }
  } as unknown as Stripe
  return { stripe, cancel, refund, listPayments, expire, listSessions }
}

function sub(status: string, latestInvoice: string | null = 'in_dup'): Stripe.Subscription {
  return { id: 'sub_dup', status, latest_invoice: latestInvoice } as unknown as Stripe.Subscription
}

describe('cancelDuplicateWorkspaceSubscription', () => {
  it('cancels the duplicate and refunds every paid payment of its first invoice, once per payment', async () => {
    const f = fakeStripe({ payments: [{ payment_intent: 'pi_1' }, {}] })
    expect(await cancelDuplicateWorkspaceSubscription(f.stripe, sub('active'), 'ws1')).toEqual({ refunded: 1 })
    expect(f.cancel).toHaveBeenCalledWith('sub_dup', { prorate: false, invoice_now: false })
    expect(f.listPayments).toHaveBeenCalledWith({ invoice: 'in_dup', status: 'paid' })
    expect(f.refund).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: 'pi_1' }),
      { idempotencyKey: 'markoto-duplicate-subscription-refund-pi_1' }
    )
  })

  it('a webhook retry does not cancel twice', async () => {
    const f = fakeStripe({ payments: [{ payment_intent: 'pi_1' }] })
    await cancelDuplicateWorkspaceSubscription(f.stripe, sub('canceled'), 'ws1')
    expect(f.cancel).not.toHaveBeenCalled()
    expect(f.refund).toHaveBeenCalledTimes(1)
  })

  it('a failed refund is reported, not thrown (the cancel stands)', async () => {
    const f = fakeStripe({ payments: [{ payment_intent: 'pi_1' }], refundFails: true })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await cancelDuplicateWorkspaceSubscription(f.stripe, sub('active'), 'ws1')).toEqual({ refunded: 0 })
    expect(f.cancel).toHaveBeenCalled()
  })
})

describe('expireOpenWorkspaceCheckouts', () => {
  it('expires open subscription Checkouts and leaves top-up payments alone', async () => {
    const f = fakeStripe({ sessions: [{ id: 'cs_a', mode: 'subscription' }, { id: 'cs_topup', mode: 'payment' }] })
    expect(await expireOpenWorkspaceCheckouts(f.stripe, 'cus_ws')).toBe(1)
    expect(f.listSessions).toHaveBeenCalledWith({ customer: 'cus_ws', status: 'open', limit: 20 })
    expect(f.expire).toHaveBeenCalledWith('cs_a')
    expect(f.expire).not.toHaveBeenCalledWith('cs_topup')
  })
})
