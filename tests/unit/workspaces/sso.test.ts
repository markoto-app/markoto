import { describe, it, expect } from 'vitest'
import { DOMAIN_TXT_PREFIX, domainHasVerificationRecord, emailDomain, normalizeSsoDomain } from '../../../server/utils/sso/domains'
import { decodeSsoFlow, encodeSsoFlow, isSafeReturnTo, SSO_FLOW_MAX_AGE_SECONDS } from '../../../server/utils/sso/flowCookie'
import { checkSsoUrl, createSsoFetch, SsoUrlRefused, SSO_FETCH_MAX_BYTES, type RawFetch } from '../../../server/utils/sso/urlPolicy'
import { assertionFromSamlProfile } from '../../../server/utils/sso/saml'
import type { Profile } from '@node-saml/node-saml'
import { partial } from '../../helpers/fixtures'

// Per-workspace single sign-on— the pure rules. End-to-end
// sign-ins: tests/integration/endpoints/sso*.test.ts.

describe('SSO domains', () => {
  it('normalises organisation domains and refuses consumer mail and junk', () => {
    expect(normalizeSsoDomain(' Example.COM. ')).toBe('example.com')
    expect(normalizeSsoDomain('@acme.ch')).toBe('acme.ch')
    expect(normalizeSsoDomain('müller.de')).toBe('xn--mller-kva.de')
    for (const bad of ['gmail.com', 'outlook.com', 'localhost', '10.0.0.1', 'a', 'exa mple.com', '-bad.com', 'x'.repeat(300) + '.com', '']) {
      expect(normalizeSsoDomain(bad), bad).toBeNull()
    }
  })

  it('takes the domain of an address', () => {
    expect(emailDomain('Ada@Example.com')).toBe('example.com')
    expect(emailDomain('no-at-sign')).toBeNull()
    expect(emailDomain(null)).toBeNull()
  })

  it('accepts only the exact TXT value, joined across strings; DNS errors are "not verified"', async () => {
    const value = `${DOMAIN_TXT_PREFIX}tok123`
    expect(await domainHasVerificationRecord('example.com', 'tok123', async () => [['v=spf1 -all'], [value]])).toBe(true)
    expect(await domainHasVerificationRecord('example.com', 'tok123', async () => [[DOMAIN_TXT_PREFIX, 'tok123']])).toBe(true)
    expect(await domainHasVerificationRecord('example.com', 'tok123', async () => [[`${value}x`]])).toBe(false)
    expect(await domainHasVerificationRecord('example.com', 'tok123', async () => {
      throw new Error('ENOTFOUND')
    })).toBe(false)
  })
})

describe('SSO flow cookie', () => {
  const secret = 'x'.repeat(32)
  const now = Date.UTC(2026, 10, 9, 12)

  it('round-trips a login and a test flow', () => {
    const login = { connectionId: 'c1', purpose: 'login' as const, state: 's', nonce: 'n', codeVerifier: 'v', returnTo: '/d/abc' }
    expect(decodeSsoFlow(encodeSsoFlow(login, secret, now), secret, now)).toEqual(login)
    const test = { connectionId: 'c1', purpose: 'test' as const, testUserId: 7, requestId: '_abc' }
    expect(decodeSsoFlow(encodeSsoFlow(test, secret, now), secret, now)).toEqual(test)
  })

  it('refuses forged, expired, wrong-secret and malformed cookies', () => {
    const raw = encodeSsoFlow({ connectionId: 'c1', purpose: 'login' }, secret, now)
    const [body, mac] = raw.split('.')
    const tampered = Buffer.from(JSON.stringify({ connectionId: 'c2', purpose: 'login', iat: Math.floor(now / 1000) })).toString('base64url')
    expect(decodeSsoFlow(`${tampered}.${mac}`, secret, now)).toBeNull()
    expect(decodeSsoFlow(raw, 'y'.repeat(32), now)).toBeNull()
    expect(decodeSsoFlow(raw, secret, now + (SSO_FLOW_MAX_AGE_SECONDS + 1) * 1000)).toBeNull()
    expect(decodeSsoFlow(`${body}`, secret, now)).toBeNull()
    expect(decodeSsoFlow(undefined, secret, now)).toBeNull()
    // A test flow must name the admin.
    expect(decodeSsoFlow(encodeSsoFlow({ connectionId: 'c1', purpose: 'test' }, secret, now), secret, now)).toBeNull()
    // An unsafe returnTo makes the whole cookie invalid.
    expect(decodeSsoFlow(encodeSsoFlow({ connectionId: 'c1', purpose: 'login', returnTo: '//evil.example' }, secret, now), secret, now)).toBeNull()
  })

  it('allows only same-site paths as returnTo', () => {
    for (const ok of ['/', '/d/abc', '/w/x?tab=sso']) expect(isSafeReturnTo(ok), ok).toBe(true)
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '/a b', '']) expect(isSafeReturnTo(bad), bad).toBe(false)
  })
})

describe('SSO outbound policy', () => {
  const resolveTo = (...addresses: string[]) => async () => addresses

  it('refuses internal names, loopback, metadata and (by default) private networks', async () => {
    await expect(checkSsoUrl('https://postgres/x')).rejects.toBeInstanceOf(SsoUrlRefused)
    await expect(checkSsoUrl('https://idp.example', { resolve: resolveTo('127.0.0.1') })).rejects.toThrow(/loopback/)
    await expect(checkSsoUrl('https://idp.example', { resolve: resolveTo('169.254.169.254') })).rejects.toThrow(/metadata|link-local/)
    await expect(checkSsoUrl('https://idp.example', { allowPrivate: false, resolve: resolveTo('10.1.2.3') })).rejects.toThrow(/private/)
    await expect(checkSsoUrl('https://user:pw@idp.example')).rejects.toThrow(/user name/)
    await expect(checkSsoUrl('ftp://idp.example')).rejects.toThrow(/https/)
  })

  it('allows https to public addresses, and http only to private ones when private IdPs are allowed', async () => {
    expect((await checkSsoUrl('https://idp.example/realm', { resolve: resolveTo('93.184.216.34') })).addresses).toEqual(['93.184.216.34'])
    await expect(checkSsoUrl('http://idp.example', { allowPrivate: true, resolve: resolveTo('93.184.216.34') })).rejects.toThrow(/https/)
    expect((await checkSsoUrl('http://idp.internal', { allowPrivate: true, resolve: resolveTo('10.0.0.5') })).addresses).toEqual(['10.0.0.5'])
  })

  it('dials the checked address with Host + SNI, never follows redirects, caps the body', async () => {
    const seen: Array<{ url: string, host: string | null, serverName?: string, method?: string }> = []
    const fetchImpl: RawFetch = async (url, init) => {
      seen.push({ url, host: new Headers(init.headers).get('host'), serverName: init.tls?.serverName, method: init.method })
      if (url.includes('/redirect')) return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
      if (url.includes('/huge')) return new Response(new Uint8Array(SSO_FETCH_MAX_BYTES + 1))
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const ssoFetch = createSsoFetch({ allowPrivate: false, resolve: resolveTo('93.184.216.34'), fetchImpl })
    const res = await ssoFetch('https://idp.example/token', { method: 'POST', body: 'grant_type=x' })
    expect(await res.json()).toEqual({ ok: true })
    expect(seen[0]).toEqual({ url: 'https://93.184.216.34/token', host: 'idp.example', serverName: 'idp.example', method: 'POST' })
    await expect(ssoFetch('https://idp.example/redirect')).rejects.toThrow(/redirect/)
    await expect(ssoFetch('https://idp.example/huge')).rejects.toThrow(/1 MiB/)
  })
})

describe('SAML profile → assertion', () => {
  const base = { issuer: 'https://idp.example', nameIDFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent' }

  it('uses NameID as subject and the common email / name attributes', () => {
    const a = assertionFromSamlProfile(partial<Profile>({ ...base, 'nameID': 'abc-123', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'ada@example.com', 'givenName': 'Ada', 'sn': 'Lovelace' }))
    expect(a).toEqual({ subject: 'abc-123', email: 'ada@example.com', emailVerified: false, name: 'Ada Lovelace' })
  })

  it('takes an emailAddress NameID as the email; drops a malformed email; refuses an empty NameID', () => {
    expect(assertionFromSamlProfile(partial<Profile>({ ...base, nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', nameID: 'bo@example.com' })).email).toBe('bo@example.com')
    expect(assertionFromSamlProfile(partial<Profile>({ ...base, nameID: 'x', email: 'not an email' })).email).toBeNull()
    expect(() => assertionFromSamlProfile(partial<Profile>({ ...base, nameID: '' }))).toThrow()
  })
})

describe('where "Sign in with your organisation" is offered', () => {
  it('self-hosted (billing off, committed free tier): yes; markoto.app free-only: no; billing on with Business: yes', async () => {
    const { resolveWorkspaceSsoAvailable } = await import('../../../shared/config/instance')
    expect(resolveWorkspaceSsoAvailable({})).toBe(true)
    expect(resolveWorkspaceSsoAvailable({ TIER_FREE_FEATURE_SSO: 'false' })).toBe(false)
    expect(resolveWorkspaceSsoAvailable({ NUXT_BILLING_ENABLED: 'true', TIER_FREE_FEATURE_SSO: 'false', TIER_PRO_FEATURE_SSO: 'false', TIER_TEAM_FEATURE_SSO: 'false' })).toBe(true)
  })
})

describe('audit-log CSV cells', () => {
  it('quotes separators and neutralises spreadsheet formulas', async () => {
    const { csvField } = await import('../../../server/utils/workspaces/workspaceAudit')
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('=SUM(A1)')).toBe('\'=SUM(A1)')
    expect(csvField('+1')).toBe('\'+1')
    expect(csvField('@cmd')).toBe('\'@cmd')
    expect(csvField(null)).toBe('')
    expect(csvField({ a: 1 })).toBe('"{""a"":1}"')
  })
})
