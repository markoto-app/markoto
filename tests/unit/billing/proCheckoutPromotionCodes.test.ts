import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
import type Stripe from 'stripe'
import { partial } from '../../helpers/fixtures'
import { asUser } from '../../helpers/access'
import { stubEnv } from '../../helpers/env'

// Launch promotion codes (a share of the first year of Pro yearly) are
// entered on Stripe's Checkout page. Only a NEW yearly Pro subscription
// offers the field: monthly never does, and an in-place change of a live
// subscription creates no Checkout Session at all.

const { state } = vi.hoisted(() => ({
  state: { subscriptionId: null as string | null }
}))

const create = vi.fn(async (_params: Stripe.Checkout.SessionCreateParams) => ({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' }))

function liveSubscription(priceId: string): Stripe.Subscription {
  return partial<Stripe.Subscription>({
    id: 'sub_live',
    status: 'active',
    customer: 'cus_user',
    cancel_at: null,
    cancel_at_period_end: false,
    pending_update: null,
    items: partial<Stripe.Subscription['items']>({
      data: [partial<Stripe.SubscriptionItem>({ id: 'si_1', quantity: 1, price: partial<Stripe.Price>({ id: priceId, lookup_key: null }) })]
    })
  })
}

const update = vi.fn(async (_id: string, _params: Stripe.SubscriptionUpdateParams) => liveSubscription('price_pro_year'))

const fakeStripe = partial<Stripe>({
  checkout: partial<Stripe['checkout']>({
    sessions: partial<Stripe['checkout']['sessions']>({
      create: create as unknown as Stripe['checkout']['sessions']['create'],
      list: (async function* () {}) as unknown as Stripe['checkout']['sessions']['list']
    })
  }),
  subscriptions: partial<Stripe['subscriptions']>({
    retrieve: (async () => liveSubscription('price_pro_month')) as unknown as Stripe['subscriptions']['retrieve'],
    update: update as unknown as Stripe['subscriptions']['update']
  }),
  prices: partial<Stripe['prices']>({ list: (async () => ({ data: [] })) as unknown as Stripe['prices']['list'] })
})

vi.mock('../../../server/repos/userBilling', async orig => ({
  ...(await orig<typeof import('../../../server/repos/userBilling')>()),
  getUserCheckoutBilling: async () => ({ email: 'maya@example.com', stripeCustomerId: 'cus_user', stripeSubscriptionId: state.subscriptionId, billingCurrency: 'eur' }),
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

const { startProCheckout } = await import('../../../server/utils/billing/proCheckout')
const { resetStripeCatalogueCache } = await import('../../../server/utils/billing/stripePrices')

const EVENT = partial<H3Event>({})
const TERMS = { acceptPaidTerms: true }
const PRICE_IDS = 'markoto_pro_month_eur=price_pro_month,markoto_pro_year_eur=price_pro_year'

function sentParams(): Stripe.Checkout.SessionCreateParams {
  const call = create.mock.calls[0]
  if (!call) throw new Error('checkout.sessions.create was not called')
  return call[0]
}

beforeEach(() => {
  create.mockClear()
  update.mockClear()
  state.subscriptionId = null
  stubEnv({ NUXT_STRIPE_PRICE_IDS: PRICE_IDS, NUXT_STRIPE_MANAGED_PAYMENTS: undefined })
  resetStripeCatalogueCache()
})

describe('promotion codes on the Pro checkout', () => {
  it('a new yearly Pro subscription accepts promotion codes', async () => {
    await startProCheckout(EVENT, { self: asUser(42), interval: 'year', currency: 'eur', terms: TERMS })
    expect(sentParams()).toMatchObject({ mode: 'subscription', allow_promotion_codes: true, line_items: [{ price: 'price_pro_year', quantity: 1 }] })
  })

  it('also with Managed Payments on, and never a preset discount', async () => {
    stubEnv({ NUXT_STRIPE_MANAGED_PAYMENTS: 'true' })
    await startProCheckout(EVENT, { self: asUser(42), interval: 'year', currency: 'eur', terms: TERMS })
    expect(sentParams()).toMatchObject({ allow_promotion_codes: true, managed_payments: { enabled: true } })
    expect(sentParams()).not.toHaveProperty('discounts')
  })

  it('a new monthly Pro subscription does not', async () => {
    await startProCheckout(EVENT, { self: asUser(42), interval: 'month', currency: 'eur', terms: TERMS })
    expect(sentParams()).not.toHaveProperty('allow_promotion_codes')
  })

  it('a request without an interval (a new subscription is monthly) does not', async () => {
    await startProCheckout(EVENT, { self: asUser(42), interval: undefined, currency: 'eur', terms: TERMS })
    expect(sentParams()).not.toHaveProperty('allow_promotion_codes')
  })

  it('switching a live monthly subscription to yearly changes it in place: no Checkout, no code', async () => {
    state.subscriptionId = 'sub_live'
    const result = await startProCheckout(EVENT, { self: asUser(42), interval: 'year', currency: 'eur', terms: TERMS })
    expect(result).toMatchObject({ updated: true, interval: 'year' })
    expect(create).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(update.mock.calls[0])).not.toContain('promotion')
  })
})
