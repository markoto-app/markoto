import { createServer } from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as oidc from 'openid-client'
import { resetDb, testDb } from '../setup/db'
import { createUser } from '../setup/fixtures'
import {
  TEST_BASE_URL,
  TEST_OIDC_ADMIN_EMAIL,
  TEST_OIDC_BASE_URL,
  TEST_OIDC_CLIENT_ID,
  TEST_OIDC_CLIENT_SECRET,
  TEST_OIDC_ISSUER
} from '../setup/env'
import { resolveOidcSettings, type OidcSettings } from '../../../server/utils/oidc/settings'
import {
  buildOidcAuthorizationRequest,
  completeOidcAuthorization,
  getOidcConfiguration,
  resetOidcConfigurationCache
} from '../../../server/utils/oidc/client'

// Generic OpenID Connect sign-in against a REAL OpenID provider:
// the `oidc-test` container (navikt mock-oauth2-server) in
// deploy/compose/compose.test.yml. Its interactive login form takes the subject
// plus arbitrary claims JSON, which is how these tests mint tokens with
// an unverified email, a foreign audience, a wrong nonce, ...
//
// Part 1 drives the full browser round trip through the Nitro server
// (`/auth/oidc` → IdP → callback → session). Part 2 calls the protocol
// layer directly to prove each ID-token check rejects a bad token
// issued by the real IdP (these failure modes can't be produced through
// the server route without a misbehaving IdP).

const FLOW_COOKIE = 'markoto-oidc-flow'
const SESSION_COOKIE = 'nuxt-session'

function cookieValue(res: Response, name: string): string | null {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(';')
    const eq = pair?.indexOf('=') ?? -1
    if (pair && eq > 0 && pair.slice(0, eq) === name) return pair.slice(eq + 1)
  }
  return null
}

/** The user in the session cookie a response set, or null. */
async function sessionUser(res: Response): Promise<Record<string, unknown> | null> {
  const session = cookieValue(res, SESSION_COOKIE)
  if (!session) return null
  const me = await fetch(`${TEST_BASE_URL}/api/_auth/session`, { headers: { cookie: `${SESSION_COOKIE}=${session}` } })
  const body: unknown = await me.json()
  if (typeof body !== 'object' || body === null) return null
  const user = (body as Record<string, unknown>).user
  return typeof user === 'object' && user !== null ? { ...user } : null
}

/** IdP login form: subject + claims → redirect back to the app with a code. */
async function loginAtIdp(authorizeUrl: string, sub: string, claims: Record<string, unknown>): Promise<string> {
  const res = await fetch(authorizeUrl, {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({ username: sub, claims: JSON.stringify(claims) })
  })
  expect(res.status).toBe(302)
  const location = res.headers.get('location')
  if (!location) throw new Error('IdP did not redirect back')
  return location
}

interface StartedFlow {
  authorizeUrl: URL
  flowCookie: string
}

async function startSignIn(returnTo?: string): Promise<StartedFlow> {
  const query = returnTo === undefined ? '' : `?return=${encodeURIComponent(returnTo)}`
  const res = await fetch(`${TEST_BASE_URL}/auth/oidc${query}`, { redirect: 'manual' })
  expect(res.status).toBe(302)
  const location = res.headers.get('location')
  const flowCookie = cookieValue(res, FLOW_COOKIE)
  if (!location || !flowCookie) throw new Error('no redirect / flow cookie')
  return { authorizeUrl: new URL(location), flowCookie }
}

async function callback(callbackUrl: string, flowCookie: string | null): Promise<Response> {
  return fetch(callbackUrl, {
    redirect: 'manual',
    headers: flowCookie ? { cookie: `${FLOW_COOKIE}=${flowCookie}` } : {}
  })
}

/** Full round trip; returns the callback response. */
async function signIn(sub: string, claims: Record<string, unknown>, returnTo?: string): Promise<Response> {
  const { authorizeUrl, flowCookie } = await startSignIn(returnTo)
  const back = await loginAtIdp(authorizeUrl.href, sub, claims)
  return callback(back, flowCookie)
}

async function usersBySubject(sub: string) {
  return (await testDb().query<{ id: number, email: string | null, name: string, oidc_issuer: string, github_id: string | null, is_admin: boolean }>(
    'SELECT id, email, name, oidc_issuer, github_id, is_admin FROM users WHERE oidc_subject = $1',
    [sub]
  )).rows
}

describe('GET /auth/oidc: full sign-in against a real IdP', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('redirects to the IdP with PKCE (S256), state, nonce and the configured scopes', async () => {
    const { authorizeUrl } = await startSignIn()
    expect(authorizeUrl.href.startsWith(`${TEST_OIDC_ISSUER}/authorize`)).toBe(true)
    const q = authorizeUrl.searchParams
    expect(q.get('client_id')).toBe(TEST_OIDC_CLIENT_ID)
    expect(q.get('response_type')).toBe('code')
    expect(q.get('redirect_uri')).toBe(`${TEST_BASE_URL}/auth/oidc`)
    expect(q.get('scope')).toBe('openid email profile')
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('code_challenge')).toMatch(/^[\w-]{43}$/)
    expect(q.get('state')).toBeTruthy()
    expect(q.get('nonce')).toBeTruthy()
  })

  it('signs a new user in, keyed by (issuer, sub), with a usable session', async () => {
    const res = await signIn('alice-sub', { email: 'alice@idp.test', email_verified: true, name: 'Alice IdP' })
    expect(res.status).toBe(302)
    // A new account: the client sends its cookieless sign-up event from this parameter.
    expect(res.headers.get('location')).toBe('/?signed_up=oidc')
    // Flow cookie is single-use.
    expect(res.headers.getSetCookie().some(c => c.startsWith(`${FLOW_COOKIE}=;`))).toBe(true)

    const rows = await usersBySubject('alice-sub')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ email: 'alice@idp.test', name: 'Alice IdP', oidc_issuer: TEST_OIDC_ISSUER, is_admin: false })

    expect(await sessionUser(res)).toMatchObject({ id: rows[0]?.id, provider: 'oidc', email: 'alice@idp.test' })

    // The session cookie must be SameSite=Lax: the callback is reached by a
    // redirect from the IdP's site, and browsers withhold a Strict cookie on
    // the rest of that cross-site redirect chain, so the page after sign-in
    // would render signed out .
    const sessionCookie = res.headers.getSetCookie().find(c => c.startsWith(`${SESSION_COOKIE}=`))
    expect(sessionCookie).toMatch(/;\s*SameSite=Lax/i)
    expect(sessionCookie).toMatch(/;\s*HttpOnly/i)

    // Second sign-in: same row.
    const again = await signIn('alice-sub', { email: 'alice@idp.test', email_verified: true, name: 'Alice Renamed' })
    expect(again.status).toBe(302)
    expect(again.headers.get('location')).toBe('/')
    expect(await usersBySubject('alice-sub')).toEqual([expect.objectContaining({ id: rows[0]?.id, name: 'Alice Renamed' })])
  })

  it('links to an existing account only when the IdP asserts email_verified=true', async () => {
    const existing = await createUser({ email: 'bob@idp.test' })

    // Unverified: new, separate account WITHOUT the email.
    const unverified = await signIn('mallory-sub', { email: 'bob@idp.test', email_verified: false })
    expect(unverified.headers.get('location')).toBe('/?signed_up=oidc')
    expect(await usersBySubject('mallory-sub')).toEqual([expect.objectContaining({ email: null, github_id: null })])

    // Verified: merged into the existing account, flash param set.
    const verified = await signIn('bob-sub', { email: 'BOB@idp.test', email_verified: true })
    expect(verified.headers.get('location')).toBe('/?linked=oidc')
    const rows = await usersBySubject('bob-sub')
    expect(rows).toEqual([expect.objectContaining({ id: existing.id, oidc_issuer: TEST_OIDC_ISSUER })])
  })

  it('bootstraps NUXT_ADMIN_USER_EMAILS only for a verified email', async () => {
    await signIn('fake-admin', { email: TEST_OIDC_ADMIN_EMAIL, email_verified: false })
    expect((await usersBySubject('fake-admin'))[0]?.is_admin).toBe(false)

    await signIn('real-admin', { email: TEST_OIDC_ADMIN_EMAIL, email_verified: true })
    expect((await usersBySubject('real-admin'))[0]?.is_admin).toBe(true)
  })

  it('rejects a callback whose state does not match the flow cookie', async () => {
    const { authorizeUrl, flowCookie } = await startSignIn()
    const back = new URL(await loginAtIdp(authorizeUrl.href, 'state-sub', {}))
    back.searchParams.set('state', 'attacker-chosen')
    const res = await callback(back.href, flowCookie)
    expect(res.status).toBe(401)
    // nuxt-auth-utils may still hand out an (empty) session cookie; it
    // must not carry a user.
    expect(await sessionUser(res)).toBeNull()
    expect(await usersBySubject('state-sub')).toEqual([])
  })

  it('rejects a callback without the flow cookie (other browser / login CSRF)', async () => {
    const { authorizeUrl } = await startSignIn()
    const back = await loginAtIdp(authorizeUrl.href, 'csrf-sub', {})
    const res = await callback(back, null)
    expect(res.status).toBe(401)
    expect(await usersBySubject('csrf-sub')).toEqual([])
  })

  it('rejects a forged flow cookie', async () => {
    const { authorizeUrl, flowCookie } = await startSignIn()
    const back = await loginAtIdp(authorizeUrl.href, 'forged-sub', {})
    const [body] = flowCookie.split('.')
    const res = await callback(back, `${body}.AAAA`)
    expect(res.status).toBe(401)
    expect(await usersBySubject('forged-sub')).toEqual([])
  })

  it('rejects a callback whose flow belongs to another attempt (nonce/PKCE mismatch)', async () => {
    const first = await startSignIn()
    const second = await startSignIn()
    // Code + state from attempt 1, but only attempt 2's cookie. State
    // differs → rejected before the code is even exchanged.
    const back = await loginAtIdp(first.authorizeUrl.href, 'mixed-sub', {})
    const res = await callback(back, second.flowCookie)
    expect(res.status).toBe(401)
    expect(await usersBySubject('mixed-sub')).toEqual([])
  })

  it('comes back to the page the sign-in link named (a new account carries signed_up)', async () => {
    const created = await signIn('return-sub', { email: 'return@idp.test', email_verified: true }, '/pricing?interval=year&currency=chf')
    expect(created.headers.get('location')).toBe('/pricing?interval=year&currency=chf&signed_up=oidc')
    const again = await signIn('return-sub', { email: 'return@idp.test', email_verified: true }, '/de/pricing?interval=year')
    expect(again.headers.get('location')).toBe('/de/pricing?interval=year')
    // Taken once: the next sign-in without a return page lands on the home page.
    expect((await signIn('return-sub', { email: 'return@idp.test', email_verified: true })).headers.get('location')).toBe('/')
  })

  it('never returns to another site or a sign-in route', async () => {
    for (const unsafe of ['//evil.example/pricing', 'https://evil.example/', '/\\evil.example', '/auth/oidc']) {
      const res = await signIn('unsafe-return-sub', { email: 'unsafe@idp.test', email_verified: true }, unsafe)
      expect(res.headers.get('location')).toMatch(/^\/(\?signed_up=oidc)?$/)
    }
  })

  it('rejects an IdP error response', async () => {
    const { authorizeUrl, flowCookie } = await startSignIn()
    const state = authorizeUrl.searchParams.get('state') ?? ''
    const res = await callback(`${TEST_BASE_URL}/auth/oidc?error=access_denied&state=${state}`, flowCookie)
    expect(res.status).toBe(401)
  })
})

describe('OIDC protocol layer: ID token validation against the real IdP', () => {
  const REDIRECT = 'http://127.0.0.1:1/cb'
  let settings: OidcSettings

  beforeEach(() => {
    resetOidcConfigurationCache()
    const resolved = resolveOidcSettings({
      TEST_MODE: '1',
      NUXT_OAUTH_OIDC_ISSUER: TEST_OIDC_ISSUER,
      NUXT_OAUTH_OIDC_CLIENT_ID: TEST_OIDC_CLIENT_ID,
      NUXT_OAUTH_OIDC_CLIENT_SECRET: TEST_OIDC_CLIENT_SECRET
    })
    if (!resolved) throw new Error('OIDC settings did not resolve')
    settings = resolved
  })

  /** `code: message` of the error and every `cause` below it, newline-joined. */
  async function rejectionChain(promise: Promise<unknown>): Promise<string> {
    try {
      await promise
    } catch (err) {
      const parts: string[] = []
      let current: unknown = err
      while (current instanceof Error) {
        const code = 'code' in current && typeof current.code === 'string' ? current.code : ''
        // ResponseBodyError carries the IdP's OAuth error code in `.error`.
        const oauthError = 'error' in current && typeof current.error === 'string' ? ` (${current.error})` : ''
        parts.push(`${code}: ${current.message}${oauthError}`)
        current = current.cause
      }
      return parts.join('\n')
    }
    throw new Error('expected the promise to reject')
  }

  async function attempt(claims: Record<string, unknown>, config?: oidc.Configuration) {
    const cfg = config ?? await getOidcConfiguration(settings)
    const { url, flow } = await buildOidcAuthorizationRequest(cfg, settings, REDIRECT)
    const back = await loginAtIdp(url.href, 'proto-sub', claims)
    return completeOidcAuthorization(cfg, new URL(back), flow)
  }

  it('accepts a well-formed token', async () => {
    await expect(attempt({ email: 'p@idp.test', email_verified: true })).resolves.toMatchObject({
      issuer: TEST_OIDC_ISSUER,
      subject: 'proto-sub',
      email: 'p@idp.test'
    })
  })

  it('rejects a token for another audience', async () => {
    await expect(attempt({ aud: 'some-other-client' })).rejects.toMatchObject({ code: 'OAUTH_JWT_CLAIM_COMPARISON_FAILED', cause: { cause: { claim: 'aud' } } })
  })

  it('rejects a token from another issuer', async () => {
    await expect(attempt({ iss: `${TEST_OIDC_BASE_URL}/evil` })).rejects.toMatchObject({ code: 'OAUTH_JWT_CLAIM_COMPARISON_FAILED', cause: { cause: { claim: 'iss' } } })
  })

  it('rejects a token with the wrong nonce', async () => {
    await expect(attempt({ nonce: 'replayed-nonce' })).rejects.toMatchObject({ code: 'OAUTH_JWT_CLAIM_COMPARISON_FAILED', cause: { cause: { claim: 'nonce' } } })
  })

  it('rejects an expired token', async () => {
    // The IdP issues a normal 1 h token; we redeem it with our clock two
    // hours ahead (only `Date` is faked, network I/O is untouched).
    const cfg = await getOidcConfiguration(settings)
    const { url, flow } = await buildOidcAuthorizationRequest(cfg, settings, REDIRECT)
    const back = await loginAtIdp(url.href, 'proto-sub', {})
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * 3600 * 1000 })
    try {
      expect(await rejectionChain(completeOidcAuthorization(cfg, new URL(back), flow)))
        .toMatch(/OAUTH_JWT_TIMESTAMP_CHECK_FAILED.*"exp"/)
    } finally {
      vi.useRealTimers()
    }
  })

  /** Same IdP metadata, but the ID token is checked against `jwksUri`. */
  async function configWithJwks(jwksUri: string): Promise<oidc.Configuration> {
    const real = await getOidcConfiguration(settings)
    // openid-client types `supportsPKCE` as an own property of the metadata, but defines it non-enumerable, so
    // the spread carries plain metadata only.
    const metadata = { ...real.serverMetadata(), jwks_uri: jwksUri } as unknown as oidc.ServerMetadata
    const config = new oidc.Configuration(
      metadata,
      TEST_OIDC_CLIENT_ID,
      undefined,
      oidc.ClientSecretBasic(TEST_OIDC_CLIENT_SECRET)
    )
    oidc.allowInsecureRequests(config)
    oidc.enableNonRepudiationChecks(config)
    return config
  }

  it('rejects a token when no JWKS key matches (kid of another issuer)', async () => {
    const config = await configWithJwks(`${TEST_OIDC_BASE_URL}/other-issuer/jwks`)
    await expect(attempt({}, config)).rejects.toMatchObject({ code: 'OAUTH_KEY_SELECTION_FAILED' })
  })

  it('rejects a token whose signature does not verify (same kid, different key)', async () => {
    // Serve another issuer's public key under the real issuer's `kid`:
    // key selection succeeds, the RSA signature check must fail.
    const foreign: unknown = await (await fetch(`${TEST_OIDC_BASE_URL}/other-issuer/jwks`)).json()
    const keys = typeof foreign === 'object' && foreign !== null ? (foreign as Record<string, unknown>).keys : null
    if (!Array.isArray(keys) || keys.length === 0) throw new Error('mock IdP returned no JWKS')
    const forgedJwks = JSON.stringify({ keys: keys.map(k => ({ ...k, kid: 'markoto' })) })
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(forgedJwks)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (typeof address !== 'object' || address === null) throw new Error('no listen address')
      const config = await configWithJwks(`http://127.0.0.1:${address.port}/jwks`)
      expect(await rejectionChain(attempt({}, config))).toMatch(/signature verification failed/)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('rejects a mismatched state', async () => {
    const cfg = await getOidcConfiguration(settings)
    const { url, flow } = await buildOidcAuthorizationRequest(cfg, settings, REDIRECT)
    const back = await loginAtIdp(url.href, 'proto-sub', {})
    expect(await rejectionChain(completeOidcAuthorization(cfg, new URL(back), { ...flow, state: 'other' })))
      .toMatch(/"state"/)
  })

  it('rejects a wrong PKCE verifier at the token endpoint', async () => {
    const cfg = await getOidcConfiguration(settings)
    const { url, flow } = await buildOidcAuthorizationRequest(cfg, settings, REDIRECT)
    const back = await loginAtIdp(url.href, 'proto-sub', {})
    const other = oidc.randomPKCECodeVerifier()
    // The IdP refuses the code exchange (invalid_grant).
    expect(await rejectionChain(completeOidcAuthorization(cfg, new URL(back), { ...flow, codeVerifier: other })))
      .toMatch(/invalid_grant|code_verifier|PKCE/i)
  })

  it('refuses discovery of a plain-http issuer outside TEST_MODE/development', () => {
    expect(resolveOidcSettings({
      NODE_ENV: 'production',
      NUXT_OAUTH_OIDC_ISSUER: TEST_OIDC_ISSUER,
      NUXT_OAUTH_OIDC_CLIENT_ID: TEST_OIDC_CLIENT_ID,
      NUXT_OAUTH_OIDC_CLIENT_SECRET: TEST_OIDC_CLIENT_SECRET
    })).toBeNull()
  })
})
