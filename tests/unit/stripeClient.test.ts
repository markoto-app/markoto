import { describe, it, expect } from 'vitest'
import { buildHostOverride } from '../../server/utils/stripeClient'

// `buildHostOverride` parses the `NUXT_STRIPE_API_BASE` env var into
// the `{host, port, protocol}` triple the Stripe SDK constructor
// expects. Enough branches (empty, malformed, default port per
// protocol, explicit port) that a direct test pins each one.

describe('buildHostOverride', () => {
  it('empty string → no override (SDK defaults to api.stripe.com)', () => {
    expect(buildHostOverride('')).toEqual({})
  })

  it('parses http URL with explicit port', () => {
    const r = buildHostOverride('http://stripe-mock:12111')
    expect(r).toEqual({ host: 'stripe-mock', port: 12111, protocol: 'http' })
  })

  it('parses https URL with explicit port', () => {
    const r = buildHostOverride('https://api.example.com:8443')
    expect(r).toEqual({ host: 'api.example.com', port: 8443, protocol: 'https' })
  })

  it('defaults port 80 for http when no explicit port', () => {
    const r = buildHostOverride('http://localhost')
    expect(r).toEqual({ host: 'localhost', port: 80, protocol: 'http' })
  })

  it('defaults port 443 for https when no explicit port', () => {
    const r = buildHostOverride('https://api.stripe.com')
    expect(r).toEqual({ host: 'api.stripe.com', port: 443, protocol: 'https' })
  })

  it('parses 127.0.0.1 IPv4 addresses', () => {
    const r = buildHostOverride('http://127.0.0.1:12111')
    expect(r).toEqual({ host: '127.0.0.1', port: 12111, protocol: 'http' })
  })

  it('throws on malformed URL (boot-time validator catches these before we reach here)', () => {
    expect(() => buildHostOverride('not-a-url')).toThrow()
  })

  it('strips trailing colon from protocol', () => {
    // Node's URL gives us `protocol: 'http:'`. We strip the colon
    // so the Stripe SDK sees the shorter form. Regression pin.
    const r = buildHostOverride('http://x:1')
    expect(r.protocol).toBe('http')
    expect(String(r.protocol)).not.toContain(':')
  })
})
