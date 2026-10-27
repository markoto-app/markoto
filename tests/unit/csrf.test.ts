import { describe, expect, it } from 'vitest'
import { isRequestOriginAllowed, type OriginCheckInput } from '../../server/utils/csrf'

// Origin check for state-changing API requests (defence in depth on top
// of the SameSite=Strict session cookie, which does not separate a
// sibling subdomain from the app).

function req(overrides: Partial<OriginCheckInput>): OriginCheckInput {
  return {
    method: 'POST',
    path: '/api/docs',
    origin: undefined,
    referer: undefined,
    secFetchSite: undefined,
    host: 'markoto.app',
    siteUrl: 'https://markoto.app',
    ...overrides
  }
}

describe('isRequestOriginAllowed', () => {
  it('allows same-origin browser requests', () => {
    expect(isRequestOriginAllowed(req({ origin: 'https://markoto.app' }))).toBe(true)
    expect(isRequestOriginAllowed(req({ origin: 'http://localhost:3001', host: 'localhost:3001', siteUrl: undefined }))).toBe(true)
  })

  it('accepts the configured site URL host even if the Host header differs', () => {
    expect(isRequestOriginAllowed(req({ origin: 'https://markoto.app', host: 'app:3000' }))).toBe(true)
  })

  it('refuses a foreign or sibling-subdomain Origin on every state-changing method', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isRequestOriginAllowed(req({ method, origin: 'https://evil.example' }))).toBe(false)
      expect(isRequestOriginAllowed(req({ method, origin: 'https://staging.markoto.app' }))).toBe(false)
    }
  })

  it('refuses an opaque `null` Origin', () => {
    expect(isRequestOriginAllowed(req({ origin: 'null' }))).toBe(false)
  })

  it('falls back to Sec-Fetch-Site when there is no Origin', () => {
    expect(isRequestOriginAllowed(req({ secFetchSite: 'same-origin' }))).toBe(true)
    expect(isRequestOriginAllowed(req({ secFetchSite: 'none' }))).toBe(true)
    expect(isRequestOriginAllowed(req({ secFetchSite: 'same-site' }))).toBe(false)
    expect(isRequestOriginAllowed(req({ secFetchSite: 'cross-site' }))).toBe(false)
  })

  it('falls back to Referer when there is neither Origin nor Sec-Fetch-Site', () => {
    expect(isRequestOriginAllowed(req({ referer: 'https://markoto.app/d/abc' }))).toBe(true)
    expect(isRequestOriginAllowed(req({ referer: 'https://evil.example/x' }))).toBe(false)
  })

  it('allows requests without any browser provenance header (non-browser clients)', () => {
    expect(isRequestOriginAllowed(req({}))).toBe(true)
  })

  it('never blocks safe methods or non-API paths', () => {
    expect(isRequestOriginAllowed(req({ method: 'GET', origin: 'https://evil.example' }))).toBe(true)
    expect(isRequestOriginAllowed(req({ path: '/mcp', origin: 'https://evil.example' }))).toBe(true)
  })

  it('exempts webhooks and the internal shared-secret endpoints', () => {
    expect(isRequestOriginAllowed(req({ path: '/api/webhooks/stripe', origin: 'https://stripe.com' }))).toBe(true)
    expect(isRequestOriginAllowed(req({ path: '/api/internal/activity', origin: 'https://evil.example' }))).toBe(true)
  })
})
