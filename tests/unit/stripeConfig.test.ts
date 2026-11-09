import { describe, it, expect } from 'vitest'
import { STRIPE_CONFIG_DEFAULTS, STRIPE_CONFIG_KEYS } from '../../shared/config/tiers'

// Stripe config SHAPE test. Catches misspelled keys and accidental
// credential leakage in the committed source. Runtime fail-fast on
// empty keys in prod is the deploy-time safety net; this is the
// source-code-time one.

describe('stripe config shape', () => {
  it('defaults object has every expected key', () => {
    for (const key of STRIPE_CONFIG_KEYS) {
      expect(STRIPE_CONFIG_DEFAULTS, `missing stripe.${key}`).toHaveProperty(key)
    }
  })

  it('every default is a string', () => {
    // Nuxt's runtime-config env resolution only works when the default
    // has the right type — string default + env var read as string.
    for (const key of STRIPE_CONFIG_KEYS) {
      const v = STRIPE_CONFIG_DEFAULTS[key]
      expect(typeof v, `stripe.${key} must be string`).toBe('string')
    }
  })

  it('credential-like defaults are empty strings', () => {
    // Keys that MUST be empty in the committed source — a non-empty
    // value means a real credential leaked. successUrl/cancelUrl are
    // public URL templates and intentionally carry defaults.
    const credentialKeys = ['secretKey', 'webhookSecret', 'pricePro', 'apiBase']
    for (const key of credentialKeys) {
      const v = (STRIPE_CONFIG_DEFAULTS as Record<string, string>)[key]
      expect(v, `stripe.${key} must be empty — set via NUXT_STRIPE_${key.toUpperCase()} in prod`).toBe('')
    }
  })

  it('has exactly the expected keys (no stray additions or removals)', () => {
    // If a new key is added to the shared module without updating
    // STRIPE_CONFIG_KEYS, the drift surfaces here.
    expect(Object.keys(STRIPE_CONFIG_DEFAULTS).sort()).toEqual([...STRIPE_CONFIG_KEYS].sort())
  })
})
