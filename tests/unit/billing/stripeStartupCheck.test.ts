import { describe, it, expect } from 'vitest'
import { stripeStartupErrors } from '../../../server/utils/billing/stripeStartupCheck'

// Boot-time Stripe validation, gated on NUXT_BILLING_ENABLED.
// Billing off must boot with NO Stripe vars at all; billing on must stay
// exactly as strict as before the flag existed.

const EMPTY = { secretKey: '', webhookSecret: '', apiBase: '' }

describe('stripeStartupErrors', () => {
  it('billing off: production boots without any Stripe configuration', () => {
    expect(stripeStartupErrors(EMPTY, { billingEnabled: false, isProduction: true })).toEqual([])
    expect(stripeStartupErrors(undefined, { billingEnabled: false, isProduction: true })).toEqual([])
  })

  it('billing off: even a malformed leftover apiBase is ignored (Stripe is never called)', () => {
    expect(stripeStartupErrors({ ...EMPTY, apiBase: 'not a url' }, { billingEnabled: false, isProduction: true })).toEqual([])
  })

  it('billing on + production: secret key and webhook secret are required', () => {
    expect(stripeStartupErrors(EMPTY, { billingEnabled: true, isProduction: true })).toEqual([
      'NUXT_STRIPE_SECRET_KEY is not set',
      'NUXT_STRIPE_WEBHOOK_SECRET is not set'
    ])
    expect(stripeStartupErrors(
      { secretKey: 'sk_live_x', webhookSecret: 'whsec_x', apiBase: '' },
      { billingEnabled: true, isProduction: true }
    )).toEqual([])
  })

  it('billing on: a malformed apiBase override fails boot in any environment', () => {
    expect(stripeStartupErrors({ ...EMPTY, apiBase: 'http//typo' }, { billingEnabled: true, isProduction: false }))
      .toEqual(['NUXT_STRIPE_API_BASE is not a valid URL: "http//typo"'])
  })

  it('billing on outside production: secrets stay optional (dev / stripe-mock)', () => {
    expect(stripeStartupErrors(EMPTY, { billingEnabled: true, isProduction: false })).toEqual([])
  })
})
