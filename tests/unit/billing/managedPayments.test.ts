import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { stubEnv } from '../../helpers/env'

// Selling through Stripe Managed Payments (Stripe / Link as merchant of
// record): what every Checkout Session sends with it on and off, and that
// the top-up checkout follows the same switch.

vi.stubGlobal('createError', (input: { statusCode: number, message: string, data?: unknown }) => Object.assign(new Error(input.message), input))

vi.mock('../../../server/utils/billing/stripePrices', () => ({
  stripeTopupPriceIdFor: vi.fn(async () => 'price_topup_25_eur')
}))

const { checkoutTaxFields, checkoutTaxMode, managedPaymentsEnabled } = await import('../../../server/utils/billing/checkoutSession')
const { createTopupCheckout } = await import('../../../server/utils/billing/topupCheckout')

/** Parameters Managed Payments' update-checkout guide says must be removed. */
const FORBIDDEN_WITH_MANAGED_PAYMENTS = [
  'automatic_tax',
  'tax_id_collection',
  'customer_update',
  'adaptive_pricing',
  'invoice_creation',
  'payment_method_types',
  'payment_method_configuration',
  'excluded_payment_method_types',
  'shipping_address_collection',
  'shipping_options'
]

beforeEach(() => {
  stubEnv({ NUXT_STRIPE_MANAGED_PAYMENTS: undefined, NUXT_STRIPE_AUTOMATIC_TAX: undefined })
})

describe('checkoutTaxFields', () => {
  it('sends nothing without a tax mode (self-hosted billing)', () => {
    expect(checkoutTaxMode()).toBe('none')
    expect(checkoutTaxFields(true)).toEqual({})
  })

  it('Stripe Tax: automatic tax, VAT id, address, and customer_update only for an existing customer', () => {
    stubEnv({ NUXT_STRIPE_AUTOMATIC_TAX: 'true' })
    expect(checkoutTaxMode()).toBe('stripe_tax')
    expect(checkoutTaxFields(false)).toEqual({
      automatic_tax: { enabled: true },
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true }
    })
    expect(checkoutTaxFields(true)).toMatchObject({ customer_update: { address: 'auto', name: 'auto' } })
  })

  it('Managed Payments: only `managed_payments`, none of the parameters it forbids', () => {
    stubEnv({ NUXT_STRIPE_MANAGED_PAYMENTS: 'true' })
    expect(managedPaymentsEnabled()).toBe(true)
    for (const existing of [true, false]) {
      const fields = checkoutTaxFields(existing)
      expect(fields).toEqual({ managed_payments: { enabled: true } })
    }
  })

  it('Managed Payments wins over Stripe Tax (Stripe refuses automatic_tax with it)', () => {
    stubEnv({ NUXT_STRIPE_MANAGED_PAYMENTS: 'true', NUXT_STRIPE_AUTOMATIC_TAX: 'true' })
    expect(checkoutTaxMode()).toBe('managed_payments')
    expect(Object.keys(checkoutTaxFields(true))).toEqual(['managed_payments'])
  })
})

function fakeStripe() {
  const create = vi.fn(async () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' }))
  return { stripe: { checkout: { sessions: { create } } } as unknown as Stripe, create }
}

const TOPUP = {
  subject: { type: 'user' as const, id: '42' },
  pack: '25' as const,
  currency: 'eur' as const,
  email: 'buyer@example.test',
  clientReferenceId: '42',
  successUrl: 'https://app.test/ok',
  cancelUrl: 'https://app.test/cancel'
}

function sentParams(create: ReturnType<typeof fakeStripe>['create']): Record<string, unknown> {
  const call = create.mock.calls[0] as unknown as [Record<string, unknown>] | undefined
  if (!call) throw new Error('checkout.sessions.create was not called')
  return call[0]
}

describe('createTopupCheckout', () => {
  it('Managed Payments on: the session sells through Stripe, keeps our metadata and customer, sends no tax field', async () => {
    stubEnv({ NUXT_STRIPE_MANAGED_PAYMENTS: 'true', NUXT_STRIPE_AUTOMATIC_TAX: 'true' })
    const { stripe, create } = fakeStripe()
    await createTopupCheckout(stripe, { ...TOPUP, customer: 'cus_1' })
    const params = sentParams(create)
    expect(params).toMatchObject({
      mode: 'payment',
      managed_payments: { enabled: true },
      customer: 'cus_1',
      client_reference_id: '42',
      metadata: { kind: 'topup', pack: '25', subject_type: 'user', subject_id: '42' },
      line_items: [{ price: 'price_topup_25_eur', quantity: 1 }]
    })
    for (const key of FORBIDDEN_WITH_MANAGED_PAYMENTS) expect(params, key).not.toHaveProperty(key)
    const intentData = params.payment_intent_data as Record<string, unknown>
    for (const key of ['statement_descriptor', 'statement_descriptor_suffix', 'receipt_email']) expect(intentData, key).not.toHaveProperty(key)
  })

  it('Managed Payments on, no customer yet: Stripe creates one from the email', async () => {
    stubEnv({ NUXT_STRIPE_MANAGED_PAYMENTS: 'true' })
    const { stripe, create } = fakeStripe()
    await createTopupCheckout(stripe, { ...TOPUP, customer: null })
    expect(sentParams(create)).toMatchObject({ customer_creation: 'always', customer_email: 'buyer@example.test', managed_payments: { enabled: true } })
  })

  it('Managed Payments off: the Stripe Tax path stays as before', async () => {
    stubEnv({ NUXT_STRIPE_AUTOMATIC_TAX: 'true' })
    const { stripe, create } = fakeStripe()
    await createTopupCheckout(stripe, { ...TOPUP, customer: 'cus_1' })
    const params = sentParams(create)
    expect(params).not.toHaveProperty('managed_payments')
    expect(params).toMatchObject({ automatic_tax: { enabled: true }, tax_id_collection: { enabled: true }, customer_update: { address: 'auto', name: 'auto' } })
  })
})
