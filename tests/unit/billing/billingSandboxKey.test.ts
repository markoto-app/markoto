import { describe, expect, it, vi } from 'vitest'
import { SANDBOX_KEY_ENV, sandboxKey } from '../../billing-sandbox/setup/env'

// The billing-sandbox tier charges cards and deletes customers: it may
// only ever run with a Stripe TEST-mode key.

describe('billing-sandbox key guard', () => {
  it('without a key the tier is off', () => {
    vi.stubEnv(SANDBOX_KEY_ENV, '')
    expect(sandboxKey()).toBeNull()
  })

  it.each(['sk_test_abc123', 'rk_test_abc123'])('accepts the test-mode key %s', (key) => {
    vi.stubEnv(SANDBOX_KEY_ENV, key)
    expect(sandboxKey()).toBe(key)
  })

  it.each(['sk_live_abc123', 'rk_live_abc123', 'pk_test_abc123', 'whsec_abc123', 'test'])('refuses %s', (key) => {
    vi.stubEnv(SANDBOX_KEY_ENV, key)
    expect(() => sandboxKey()).toThrow(/not a Stripe test-mode key/)
  })

  it('never puts the key into the error', () => {
    vi.stubEnv(SANDBOX_KEY_ENV, 'sk_live_hidden')
    expect(() => sandboxKey()).toThrow(expect.not.objectContaining({ message: expect.stringContaining('hidden') }))
  })
})
