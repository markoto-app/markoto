import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { stubEnv } from '../../helpers/env'

// The operator's notice for every refund (`charge.refunded`), and the
// currency guards of the top-up webhook under Adaptive Pricing (always on
// with Stripe Managed Payments): amounts and currency stay in the price's
// currency, the buyer's own is only in `presentment_details`.

const sent = vi.fn(async (_args: unknown) => ({ delivered: true }))
vi.mock('../../../server/utils/email/sendEmail', () => ({ safeSendTransactionalEmail: (args: unknown) => sent(args) }))

const subjectForCustomer = vi.fn(async (_customerId: string, _db: unknown): Promise<unknown> => null)
vi.mock('../../../server/utils/billing/stripeEvents/billingSubjects', () => ({
  subjectForCustomer: (customerId: string, db: unknown) => subjectForCustomer(customerId, db)
}))
vi.mock('../../../server/repos/workspaceSubscriptions', () => ({
  getWorkspaceSubscription: vi.fn(async () => ({ plan: 'team' }))
}))

const insertCreditGrant = vi.fn(async (_by: unknown, _grant: unknown, _db?: unknown) => true)
const refundCreditGrant = vi.fn(async (_by: unknown, _pi: string, _fraction: number, _db?: unknown): Promise<unknown> => null)
vi.mock('../../../server/repos/aiCreditGrants', () => ({
  insertCreditGrant: (by: unknown, grant: unknown, db?: unknown) => insertCreditGrant(by, grant, db),
  refundCreditGrant: (by: unknown, pi: string, fraction: number, db?: unknown) => refundCreditGrant(by, pi, fraction, db)
}))
vi.mock('../../../server/repos/userBilling', () => ({ stampFirstStripeCustomer: vi.fn(async () => undefined) }))
vi.mock('../../../server/utils/billing/aiCredits', () => ({ recomputeCreditBudget: vi.fn(async () => undefined) }))

const { buildRefundNotice, dashboardPaymentUrl, sendRefundNotice } = await import('../../../server/utils/billing/refundNotice')
const { handleChargeRefunded, handleTopupCheckout } = await import('../../../server/utils/billing/stripeEvents/creditTopups')

function charge(overrides: Record<string, unknown> = {}): Stripe.Charge {
  return {
    id: 'ch_1',
    object: 'charge',
    amount: 2500,
    amount_refunded: 2500,
    currency: 'eur',
    livemode: true,
    payment_intent: 'pi_1',
    customer: 'cus_1',
    billing_details: { email: 'buyer@example.test' },
    receipt_email: null,
    metadata: {},
    ...overrides
  } as unknown as Stripe.Charge
}

function fakeStripe(opts: { meta?: Record<string, string>, refund?: { amount: number, reason: string | null } } = {}) {
  return {
    refunds: { list: vi.fn(async () => ({ data: opts.refund ? [opts.refund] : [] })) },
    paymentIntents: { retrieve: vi.fn(async () => ({ id: 'pi_1', metadata: opts.meta ?? {} })) }
  } as unknown as Stripe
}

function lastEmail(): { to: string, subject: string, body: string, kind: string } {
  const call = sent.mock.calls.at(-1)
  if (!call) throw new Error('no email sent')
  return call[0] as { to: string, subject: string, body: string, kind: string }
}

beforeEach(() => {
  sent.mockClear()
  insertCreditGrant.mockClear()
  refundCreditGrant.mockClear()
  subjectForCustomer.mockReset().mockResolvedValue(null)
  stubEnv({ NUXT_BILLING_NOTIFY_EMAIL: 'billing@example.test' })
})

describe('buildRefundNotice', () => {
  it('names customer, purchase, amount + currency, reason and the dashboard link', () => {
    const { subject, body } = buildRefundNotice({
      chargeId: 'ch_1',
      paymentIntentId: 'pi_1',
      livemode: true,
      customerEmail: 'buyer@example.test',
      purchase: 'AI credits, pack 25 (user 42)',
      refundedNow: 1000,
      refundedTotal: 1000,
      chargeAmount: 2500,
      currency: 'eur',
      presentment: { amount: 2790, currency: 'usd' },
      reason: 'requested_by_customer'
    })
    expect(subject).toBe('[markoto billing] Refund 10.00 EUR: AI credits, pack 25 (user 42)')
    expect(body).toContain('Customer: buyer@example.test')
    expect(body).toContain('Refunded in total: 10.00 EUR of 25.00 EUR')
    expect(body).toContain('Paid by the buyer: 27.90 USD')
    expect(body).toContain('Reason: requested_by_customer')
    expect(body).toContain('Stripe: https://dashboard.stripe.com/payments/pi_1')
    expect(body).not.toContain(String.fromCodePoint(0x2014))
  })

  it('links the test-mode dashboard for a test payment', () => {
    expect(dashboardPaymentUrl({ paymentIntentId: null, chargeId: 'ch_9', livemode: false })).toBe('https://dashboard.stripe.com/test/payments/ch_9')
  })
})

describe('sendRefundNotice', () => {
  it('a refunded top-up: pack from the payment intent, latest refund amount and reason', async () => {
    await sendRefundNotice(fakeStripe({ meta: { kind: 'topup', pack: '25', subject_type: 'user', subject_id: '42' }, refund: { amount: 2500, reason: 'requested_by_customer' } }), charge())
    const email = lastEmail()
    expect(email.kind).toBe('billing.refund_notice')
    expect(email.to).toBe('billing@example.test')
    expect(email.subject).toBe('[markoto billing] Refund 25.00 EUR: AI credits, pack 25 (user 42)')
    expect(email.body).toContain('Reason: requested_by_customer')
  })

  it('a refunded plan payment names the workspace plan', async () => {
    subjectForCustomer.mockResolvedValue({ kind: 'workspace', workspaceId: 'ws_1' })
    await sendRefundNotice(fakeStripe(), charge({ amount_refunded: 900 }))
    expect(lastEmail().subject).toBe('[markoto billing] Refund 9.00 EUR: team (workspace ws_1)')
  })

  it('without NUXT_BILLING_NOTIFY_EMAIL nothing is sent', async () => {
    stubEnv({ NUXT_BILLING_NOTIFY_EMAIL: undefined })
    await sendRefundNotice(fakeStripe(), charge())
    expect(sent).not.toHaveBeenCalled()
  })

  it('a failing Stripe lookup still sends a notice', async () => {
    const stripe = {
      refunds: { list: vi.fn(async () => { throw new Error('down') }) },
      paymentIntents: { retrieve: vi.fn(async () => { throw new Error('down') }) }
    } as unknown as Stripe
    await sendRefundNotice(stripe, charge())
    expect(lastEmail().body).toContain('Purchase: unknown')
  })
})

function refundedEvent(c: Stripe.Charge): Stripe.ChargeRefundedEvent {
  return { id: 'evt_1', type: 'charge.refunded', data: { object: c } } as unknown as Stripe.ChargeRefundedEvent
}

describe('handleChargeRefunded', () => {
  it('queues the operator notice after commit, for top-ups and plans alike', async () => {
    const deferAfterCommit: Array<() => Promise<void>> = []
    const result = await handleChargeRefunded(refundedEvent(charge()), { stripe: fakeStripe(), deferAfterCommit })
    expect(result).toEqual({ matched: 0 })
    expect(sent).not.toHaveBeenCalled()
    expect(deferAfterCommit).toHaveLength(1)
    for (const job of deferAfterCommit) await job()
    expect(sent).toHaveBeenCalledTimes(1)
  })

  it('takes the refunded share of a top-up from the charge in its own currency, not the presentment one', async () => {
    refundCreditGrant.mockResolvedValueOnce({ type: 'user', id: '42' })
    const deferAfterCommit: Array<() => Promise<void>> = []
    const c = charge({ amount: 2500, amount_refunded: 1250, presentment_details: { presentment_amount: 2790, presentment_currency: 'usd' } })
    expect(await handleChargeRefunded(refundedEvent(c), { stripe: fakeStripe(), deferAfterCommit })).toEqual({ matched: 1 })
    expect(refundCreditGrant.mock.calls[0]?.[2]).toBe(0.5)
    expect(deferAfterCommit).toHaveLength(2)
  })
})

function topupSession(overrides: Record<string, unknown> = {}): Stripe.Checkout.Session {
  return {
    id: 'cs_1',
    mode: 'payment',
    payment_status: 'paid',
    payment_intent: 'pi_1',
    customer: 'cus_1',
    currency: 'chf',
    amount_total: 2500,
    metadata: { kind: 'topup', pack: '25', subject_type: 'user', subject_id: '42' },
    ...overrides
  } as unknown as Stripe.Checkout.Session
}

describe('handleTopupCheckout under Adaptive Pricing', () => {
  it('grants in the price currency when the buyer paid in another (presentment_details)', async () => {
    const result = await handleTopupCheckout(topupSession({
      presentment_details: { presentment_amount: 3105, presentment_currency: 'usd' }
    }), {})
    expect(result).toEqual({ matched: 1, plan: null })
    expect(insertCreditGrant.mock.calls[0]?.[1]).toMatchObject({ currency: 'chf', amountPaid: 2500 })
  })

  it('still refuses a session whose own currency is not EUR / CHF', async () => {
    const result = await handleTopupCheckout(topupSession({ currency: 'usd' }), {})
    expect(result).toEqual({ matched: 0, plan: null })
    expect(insertCreditGrant).not.toHaveBeenCalled()
  })
})
