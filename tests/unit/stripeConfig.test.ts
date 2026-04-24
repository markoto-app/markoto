import { describe, it, expect } from 'vitest'
import { STRIPE_CONFIG_DEFAULTS, STRIPE_CONFIG_KEYS } from '../../shared/config/tiers'

// Stripe config SHAPE test. Phase 1 adds `config.stripe.*` with empty
// string placeholders — nothing reads them yet. The only value this
// test adds now is catching a misspelled key before phase 7 goes to
// use it. Phase 7 adds a fail-fast runtime check for non-empty keys
// in prod.

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
    const credentialKeys = ['secretKey', 'webhookSecret', 'pricePro', 'priceMax', 'priceUltra', 'apiBase']
    for (const key of credentialKeys) {
      const v = (STRIPE_CONFIG_DEFAULTS as Record<string, string>)[key]
      expect(v, `stripe.${key} must be empty — set via NUXT_STRIPE_${key.toUpperCase()} in prod`).toBe('')
    }
  })

  it('has exactly the expected keys (no stray additions or removals)', () => {
    // If a future phase adds a key to the shared module without
    // updating STRIPE_CONFIG_KEYS, the drift surfaces here.
    expect(Object.keys(STRIPE_CONFIG_DEFAULTS).sort()).toEqual([...STRIPE_CONFIG_KEYS].sort())
  })
})
