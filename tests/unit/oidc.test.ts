import { describe, expect, it } from 'vitest'
import { oidcRedirectErrors, oidcRedirectUri, parseOidcScopes, resolveOidcSettings } from '../../server/utils/oidc/settings'
import { OidcProfileError, profileFromClaims } from '../../server/utils/oidc/profile'
import { OIDC_FLOW_MAX_AGE_SECONDS, decodeFlowCookie, encodeFlowCookie } from '../../server/utils/oidc/flowCookie'

// Generic OpenID Connect sign-in (WP7b) — the pure pieces. The protocol
// validation itself (signature, iss, aud, exp, nonce, state, PKCE) is
// exercised against a real IdP in tests/integration/endpoints/oidcLogin.test.ts.

const ISSUER = 'https://idp.example.org/realms/markoto'
const FULL = {
  NUXT_OAUTH_OIDC_ISSUER: ISSUER,
  NUXT_OAUTH_OIDC_CLIENT_ID: 'markoto',
  NUXT_OAUTH_OIDC_CLIENT_SECRET: 's3cret'
}

// Regression (Host-header fallback): without `_REDIRECT_URL` / site URL
// the redirect URI used to be built from the request's Host header.
describe('oidcRedirectUri', () => {
  it('prefers the explicit redirect URL, then NUXT_SITE_URL', () => {
    expect(oidcRedirectUri({ redirectUrl: 'https://login.example.org/auth/oidc' }, 'https://docs.example.org')).toBe('https://login.example.org/auth/oidc')
    expect(oidcRedirectUri({ redirectUrl: null }, 'https://docs.example.org/')).toBe('https://docs.example.org/auth/oidc')
  })

  it('has no request-derived fallback: null when neither is configured', () => {
    expect(oidcRedirectUri({ redirectUrl: null }, '')).toBeNull()
    expect(oidcRedirectUri({ redirectUrl: null }, undefined)).toBeNull()
  })

  it('boot validation refuses OIDC without a redirect URI source', () => {
    expect(oidcRedirectErrors({ redirectUrl: null }, '')).toHaveLength(1)
    expect(oidcRedirectErrors({ redirectUrl: null }, 'https://docs.example.org')).toEqual([])
    expect(oidcRedirectErrors(null, '')).toEqual([])
  })
})

describe('resolveOidcSettings', () => {
  it('is off without any OIDC variable', () => {
    expect(resolveOidcSettings({})).toEqual({ settings: null, errors: [] })
  })

  it('needs issuer, client id and secret together', () => {
    const { settings, errors } = resolveOidcSettings({ NUXT_OAUTH_OIDC_ISSUER: ISSUER, NUXT_OAUTH_OIDC_CLIENT_ID: 'x' })
    expect(settings).toBeNull()
    expect(errors[0]).toMatch(/must be set together/)
    expect(errors[0]).toContain('secret=empty')
    expect(errors[0]).not.toContain('x')
  })

  it('parses a complete config with defaults', () => {
    const { settings, errors } = resolveOidcSettings(FULL)
    expect(errors).toEqual([])
    expect(settings).toMatchObject({
      clientId: 'markoto',
      clientSecret: 's3cret',
      scopes: ['openid', 'email', 'profile'],
      redirectUrl: null,
      allowInsecureHttp: false
    })
    expect(settings?.issuer.href).toBe(ISSUER)
  })

  it('requires an https issuer in production', () => {
    const { settings, errors } = resolveOidcSettings({ ...FULL, NUXT_OAUTH_OIDC_ISSUER: 'http://idp.local' })
    expect(settings).toBeNull()
    expect(errors[0]).toMatch(/must use https/)
  })

  it('allows a plain-http issuer only under TEST_MODE or development', () => {
    const http = { ...FULL, NUXT_OAUTH_OIDC_ISSUER: 'http://127.0.0.1:4130/markoto' }
    expect(resolveOidcSettings({ ...http, TEST_MODE: '1' }).settings?.allowInsecureHttp).toBe(true)
    expect(resolveOidcSettings({ ...http, NODE_ENV: 'development' }).settings?.allowInsecureHttp).toBe(true)
    expect(resolveOidcSettings({ ...http, NODE_ENV: 'production' }).settings).toBeNull()
  })

  it('rejects malformed issuer and redirect URLs', () => {
    expect(resolveOidcSettings({ ...FULL, NUXT_OAUTH_OIDC_ISSUER: 'not a url' }).errors[0]).toMatch(/not a valid URL/)
    expect(resolveOidcSettings({ ...FULL, NUXT_OAUTH_OIDC_ISSUER: `${ISSUER}?x=1` }).errors[0]).toMatch(/query string/)
    expect(resolveOidcSettings({ ...FULL, NUXT_OAUTH_OIDC_REDIRECT_URL: 'nope' }).errors[0]).toMatch(/REDIRECT_URL/)
    expect(resolveOidcSettings({ ...FULL, NUXT_OAUTH_OIDC_REDIRECT_URL: 'https://docs.example.org/auth/oidc' }).settings?.redirectUrl)
      .toBe('https://docs.example.org/auth/oidc')
  })
})

describe('parseOidcScopes', () => {
  it('defaults and always includes openid', () => {
    expect(parseOidcScopes(undefined)).toEqual(['openid', 'email', 'profile'])
    expect(parseOidcScopes('email profile groups')).toEqual(['openid', 'email', 'profile', 'groups'])
    expect(parseOidcScopes('openid,email, email')).toEqual(['openid', 'email'])
  })
})

describe('profileFromClaims', () => {
  const base = { iss: ISSUER, sub: 'abc-123' }

  it('keys on issuer + sub and keeps a verified email', () => {
    expect(profileFromClaims({ ...base, email: 'Olga@Example.org', email_verified: true, name: 'Olga' })).toEqual({
      issuer: ISSUER,
      subject: 'abc-123',
      email: 'Olga@Example.org',
      emailVerified: true,
      name: 'Olga',
      avatarUrl: null
    })
  })

  it('drops an unverified email entirely (no merge, no admin bootstrap, not stored)', () => {
    for (const verified of [false, undefined, 'true', 1]) {
      const p = profileFromClaims({ ...base, email: 'victim@example.org', email_verified: verified })
      expect(p.email).toBeNull()
      expect(p.emailVerified).toBe(false)
    }
  })

  it('takes email + email_verified from the same source (UserInfo wins when it has an email)', () => {
    // ID token says verified, UserInfo carries a different, unverified address.
    const p = profileFromClaims(
      { ...base, email: 'a@example.org', email_verified: true },
      { sub: 'abc-123', email: 'b@example.org' }
    )
    expect(p.email).toBeNull()
    // UserInfo without an email: fall back to the ID token's pair.
    const q = profileFromClaims({ ...base, email: 'a@example.org', email_verified: true }, { sub: 'abc-123', name: 'From UserInfo' })
    expect(q).toMatchObject({ email: 'a@example.org', name: 'From UserInfo' })
  })

  it('rejects a UserInfo response for another subject', () => {
    expect(() => profileFromClaims(base, { sub: 'someone-else' })).toThrow(OidcProfileError)
  })

  it('requires iss and a sane sub', () => {
    expect(() => profileFromClaims({ sub: 'x' })).toThrow(/issuer/)
    expect(() => profileFromClaims({ iss: ISSUER })).toThrow(/subject/)
    expect(() => profileFromClaims({ iss: ISSUER, sub: 'x'.repeat(256) })).toThrow(/subject/)
  })

  it('derives a display name from the best available claim', () => {
    expect(profileFromClaims({ ...base, given_name: 'Olga', family_name: 'K' }).name).toBe('Olga K')
    expect(profileFromClaims({ ...base, preferred_username: 'olga' }).name).toBe('olga')
    expect(profileFromClaims({ ...base, email: 'olga@example.org', email_verified: true }).name).toBe('olga')
    expect(profileFromClaims(base).name).toBe('User')
    expect(profileFromClaims({ ...base, name: 'n'.repeat(400) }).name).toHaveLength(255)
  })

  it('accepts only http(s) avatar URLs', () => {
    expect(profileFromClaims({ ...base, picture: 'https://idp.example.org/a.png' }).avatarUrl).toBe('https://idp.example.org/a.png')
    expect(profileFromClaims({ ...base, picture: 'javascript:alert(1)' }).avatarUrl).toBeNull()
    expect(profileFromClaims({ ...base, picture: 'data:image/png;base64,AAAA' }).avatarUrl).toBeNull()
  })

  it('ignores malformed emails even when "verified"', () => {
    expect(profileFromClaims({ ...base, email: 'not-an-email', email_verified: true }).email).toBeNull()
  })
})

describe('flow cookie', () => {
  const secret = 'session-password-for-tests-'.padEnd(40, 'x')
  const flow = { state: 'st', nonce: 'no', codeVerifier: 'cv' }
  const now = 1_800_000_000_000

  it('round-trips', () => {
    expect(decodeFlowCookie(encodeFlowCookie(flow, secret, now), secret, now + 1000)).toEqual(flow)
  })

  it('rejects a missing, tampered or foreign-key cookie', () => {
    const raw = encodeFlowCookie(flow, secret, now)
    expect(decodeFlowCookie(undefined, secret, now)).toBeNull()
    expect(decodeFlowCookie(raw, `${secret}-other`, now)).toBeNull()
    const [body, mac] = raw.split('.')
    const forged = Buffer.from(JSON.stringify({ ...flow, state: 'attacker', iat: now / 1000 })).toString('base64url')
    expect(decodeFlowCookie(`${forged}.${mac}`, secret, now)).toBeNull()
    expect(decodeFlowCookie(`${body}.${mac}x`, secret, now)).toBeNull()
    expect(decodeFlowCookie(`${body}`, secret, now)).toBeNull()
  })

  it('expires after the max age', () => {
    const raw = encodeFlowCookie(flow, secret, now)
    expect(decodeFlowCookie(raw, secret, now + (OIDC_FLOW_MAX_AGE_SECONDS + 1) * 1000)).toBeNull()
  })
})
