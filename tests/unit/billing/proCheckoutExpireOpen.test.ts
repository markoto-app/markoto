import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
import type Stripe from 'stripe'
import { partial } from '../../helpers/fixtures'
import { asUser } from '../../helpers/access'
import { stubEnv } from '../../helpers/env'
import { captureLogs } from '../../helpers/logs'

// Two tabs (or a stale Checkout page) would each buy a Pro subscription.
// Opening a new personal Checkout expires the user's other open ones, so
// only the newest can be paid. Top-ups and other subjects' sessions are
// never touched, and a Stripe failure here never blocks the purchase.

const { state } = vi.hoisted(() => ({
  state: { customerId: 'cus_user' as string | null, sessions: [] as Array<Partial<Stripe.Checkout.Session>>, listFails: false, expireError: null as unknown }
}))

async function* items<T>(list: T[]): AsyncGenerator<T> {
  for (const item of list) yield item
}

const create = vi.fn(async (_params: Stripe.Checkout.SessionCreateParams) => ({ id: 'cs_new', url: 'https://checkout.stripe.com/c/cs_new' }))
const list = vi.fn((_params: Stripe.Checkout.SessionListParams) => {
  if (state.listFails) throw new Error('stripe down')
  return items(state.sessions)
})
const expire = vi.fn(async (_id: string) => {
  if (state.expireError) throw state.expireError
  return {}
})

const fakeStripe = partial<Stripe>({
  checkout: partial<Stripe['checkout']>({
    sessions: partial<Stripe['checkout']['sessions']>({
      create: create as unknown as Stripe['checkout']['sessions']['create'],
      list: list as unknown as Stripe['checkout']['sessions']['list'],
      expire: expire as unknown as Stripe['checkout']['sessions']['expire']
    })
  }),
  prices: partial<Stripe['prices']>({ list: (async () => ({ data: [] })) as unknown as Stripe['prices']['list'] })
})

vi.mock('../../../server/repos/userBilling', async orig => ({
  ...(await orig<typeof import('../../../server/repos/userBilling')>()),
  getUserCheckoutBilling: async () => ({ email: 'maya@example.com', stripeCustomerId: state.customerId, stripeSubscriptionId: null, billingCurrency: state.customerId ? 'eur' : null }),
  recordOwnPlanChange: async () => {}
}))
vi.mock('../../../server/utils/billing/stripeClient', () => ({ useStripeClient: () => fakeStripe }))
vi.mock('../../../server/utils/billing/paidTerms', async orig => ({
  ...(await orig<typeof import('../../../server/utils/billing/paidTerms')>()),
  recordPaidTermsAcceptance: async () => {}
}))
vi.mock('../../../server/utils/billing/workspaceStripe', () => ({ requestBaseUrl: () => 'https://app.test' }))
vi.mock('../../../server/repos/audit', () => ({ appendAuditEvent: async () => {} }))
vi.mock('../../../server/utils/platform/clientIp', () => ({ getClientIp: () => null }))

const { startProCheckout, expireOpenProCheckouts } = await import('../../../server/utils/billing/proCheckout')
const { resetStripeCatalogueCache } = await import('../../../server/utils/billing/stripePrices')

const logs = captureLogs()
const EVENT = partial<H3Event>({})
const TERMS = { acceptPaidTerms: true }
const OWN_META = { subject_type: 'user', subject_id: '42' }

function proSession(id: string, over: Partial<Stripe.Checkout.Session> = {}): Partial<Stripe.Checkout.Session> {
  return { id, mode: 'subscription', client_reference_id: '42', metadata: OWN_META, ...over }
}

beforeEach(() => {
  create.mockClear()
  list.mockClear()
  expire.mockClear()
  state.customerId = 'cus_user'
  state.sessions = []
  state.listFails = false
  state.expireError = null
  stubEnv({ NUXT_STRIPE_PRICE_IDS: 'markoto_pro_month_eur=price_pro_month', NUXT_STRIPE_MANAGED_PAYMENTS: undefined })
  resetStripeCatalogueCache()
})

describe('a new Pro checkout expires the user\'s other open ones', () => {
  it('lists the customer\'s open sessions and expires only own Pro checkouts, before creating the new one', async () => {
    state.sessions = [
      proSession('cs_old_tab'),
      proSession('cs_topup', { mode: 'payment', metadata: { kind: 'topup', ...OWN_META } }),
      proSession('cs_other_user', { client_reference_id: '7', metadata: { subject_type: 'user', subject_id: '7' } }),
      proSession('cs_workspace', { client_reference_id: 'workspace:ws1', metadata: { subject_type: 'workspace', subject_id: 'ws1' } }),
      proSession('cs_no_meta', { metadata: {} })
    ]
    const result = await startProCheckout(EVENT, { self: asUser(42), interval: 'month', currency: 'eur', terms: TERMS })
    expect(result).toEqual({ url: 'https://checkout.stripe.com/c/cs_new', sessionId: 'cs_new' })
    expect(list).toHaveBeenCalledWith({ customer: 'cus_user', status: 'open', limit: 100 })
    expect(expire.mock.calls.map(c => c[0])).toEqual(['cs_old_tab'])
    expect(expire.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0] as number)
  })

  it('a first-time buyer (no customer yet) is matched among the open sessions of the last 24 h', async () => {
    state.sessions = [proSession('cs_first_tab', { customer: null, customer_email: 'maya@example.com' }), proSession('cs_other_db', { customer: null, customer_email: 'someone@example.com' }), proSession('cs_someone', { client_reference_id: '9', metadata: { subject_type: 'user', subject_id: '9' } })]
    const now = new Date('2026-11-25T12:00:00Z')
    expect(await expireOpenProCheckouts(fakeStripe, { userId: 42, customerId: null, email: 'maya@example.com' }, now)).toBe(1)
    expect(list).toHaveBeenCalledWith({ status: 'open', created: { gte: now.getTime() / 1000 - 24 * 3600 }, limit: 100 })
    expect(expire).toHaveBeenCalledWith('cs_first_tab')
  })

  it('a buyer with neither customer nor email has nothing to match', async () => {
    expect(await expireOpenProCheckouts(fakeStripe, { userId: 42, customerId: null, email: null })).toBe(0)
    expect(list).not.toHaveBeenCalled()
  })

  it('a session completed or expired in the meantime is skipped', async () => {
    state.sessions = [proSession('cs_done')]
    state.expireError = Object.assign(new Error('not open'), { type: 'StripeInvalidRequestError' })
    expect(await expireOpenProCheckouts(fakeStripe, { userId: 42, customerId: 'cus_user', email: null })).toBe(0)
    expect(logs.find('warn')).toBeUndefined()
  })

  it('a Stripe failure is logged and the checkout still opens', async () => {
    state.listFails = true
    const result = await startProCheckout(EVENT, { self: asUser(42), interval: 'month', currency: 'eur', terms: TERMS })
    expect(result).toMatchObject({ sessionId: 'cs_new' })
    expect(logs.find('warn', 'open checkouts not expired')).toMatchObject({ component: 'billing' })
  })

  it('any other expire error is logged, not thrown', async () => {
    state.sessions = [proSession('cs_old')]
    state.expireError = Object.assign(new Error('rate limited'), { type: 'StripeRateLimitError' })
    expect(await expireOpenProCheckouts(fakeStripe, { userId: 42, customerId: 'cus_user', email: null })).toBe(0)
    expect(logs.find('warn', 'open checkouts not expired')).toBeTruthy()
  })

  it('stops reading after 500 sessions', async () => {
    state.sessions = Array.from({ length: 600 }, (_, i) => proSession(`cs_${i}`, { client_reference_id: '1', metadata: { subject_type: 'user', subject_id: '1' } }))
    state.sessions.push(proSession('cs_beyond', { customer_email: 'maya@example.com' }))
    expect(await expireOpenProCheckouts(fakeStripe, { userId: 42, customerId: null, email: 'maya@example.com' })).toBe(0)
    expect(expire).not.toHaveBeenCalled()
  })
})
