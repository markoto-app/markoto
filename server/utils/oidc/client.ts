// Generic OpenID Connect sign-in (WP7b) — protocol layer.
//
// Built on `openid-client` (panva; certified OpenID RP library) rather than
// nuxt-auth-utils' `defineOAuthOidcEventHandler`: as of nuxt-auth-utils
// 0.5.32 that handler DECODES the ID token without verifying its signature,
// issuer, audience or expiry, skips the nonce check when both sides are
// undefined, and takes the identity from UserInfo without binding it to
// the ID token's `sub`. Here:
//
//   - Discovery via `<issuer>/.well-known/openid-configuration`; the
//     discovered `issuer` must equal the configured one.
//   - Authorization code flow with PKCE (S256) + `state` + `nonce`, all
//     fresh per attempt and bound to the browser via an httpOnly cookie
//     (`server/routes/auth/oidc.get.ts`).
//   - ID token REQUIRED and validated: signature against the IdP's JWKS
//     (`enableNonRepudiationChecks`; asymmetric algorithms only — HS*
//     tokens are rejected), `iss`, `aud` (+ `azp` with multiple
//     audiences), `exp` / `iat` (30 s clock tolerance), `nonce`. The
//     `iss` authorization-response parameter is checked when the IdP
//     advertises it (RFC 9207).
//   - UserInfo (when the IdP has the endpoint) must carry the same `sub`.
//
// The module keeps one discovered `Configuration` per settings tuple for
// an hour; openid-client caches the JWKS on it and refetches on an
// unknown `kid` (key rotation).

import * as oidc from 'openid-client'
import type { OidcSettings } from './settings'
import { profileFromClaims, type OidcProfile } from './profile'

const DISCOVERY_TTL_MS = 60 * 60 * 1000
const HTTP_TIMEOUT_SECONDS = 10

/** Per-attempt secrets that must survive the round trip to the IdP. */
export interface OidcFlowState {
  state: string
  nonce: string
  codeVerifier: string
}

interface CacheEntry {
  key: string
  expiresAt: number
  config: Promise<oidc.Configuration>
}

let cache: CacheEntry | null = null

function cacheKey(settings: OidcSettings): string {
  return JSON.stringify([settings.issuer.href, settings.clientId, settings.clientSecret, settings.allowInsecureHttp])
}

async function discover(settings: OidcSettings): Promise<oidc.Configuration> {
  const execute = settings.allowInsecureHttp ? [oidc.allowInsecureRequests] : []
  const discovered = await oidc.discovery(
    settings.issuer,
    settings.clientId,
    undefined,
    oidc.ClientSecretBasic(settings.clientSecret),
    { execute, timeout: HTTP_TIMEOUT_SECONDS }
  )
  // `client_secret_basic` is the OIDC default; switch to
  // `client_secret_post` only when the IdP says it doesn't take basic.
  const methods = discovered.serverMetadata().token_endpoint_auth_methods_supported
  let config = discovered
  if (Array.isArray(methods) && !methods.includes('client_secret_basic') && methods.includes('client_secret_post')) {
    config = new oidc.Configuration(
      discovered.serverMetadata(),
      settings.clientId,
      undefined,
      oidc.ClientSecretPost(settings.clientSecret)
    )
    config.timeout = HTTP_TIMEOUT_SECONDS
    for (const fn of execute) fn(config)
  }
  oidc.enableNonRepudiationChecks(config)
  return config
}

/** Discovered + cached client configuration. A failed discovery is not cached. */
export function getOidcConfiguration(settings: OidcSettings, now = Date.now()): Promise<oidc.Configuration> {
  const key = cacheKey(settings)
  if (cache && cache.key === key && cache.expiresAt > now) return cache.config
  const entry: CacheEntry = { key, expiresAt: now + DISCOVERY_TTL_MS, config: discover(settings) }
  cache = entry
  entry.config.catch(() => {
    if (cache === entry) cache = null
  })
  return entry.config
}

/** Test seam: forget the cached discovery. */
export function resetOidcConfigurationCache(): void {
  cache = null
}

export async function buildOidcAuthorizationRequest(
  config: oidc.Configuration,
  settings: OidcSettings,
  redirectUri: string
): Promise<{ url: URL, flow: OidcFlowState }> {
  const flow: OidcFlowState = {
    state: oidc.randomState(),
    nonce: oidc.randomNonce(),
    codeVerifier: oidc.randomPKCECodeVerifier()
  }
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: settings.scopes.join(' '),
    code_challenge: await oidc.calculatePKCECodeChallenge(flow.codeVerifier),
    code_challenge_method: 'S256',
    state: flow.state,
    nonce: flow.nonce
  })
  return { url, flow }
}

/**
 * Exchange the authorization code and return the validated profile.
 * Throws on ANY protocol or validation failure (state, nonce, PKCE,
 * signature, issuer, audience, expiry, UserInfo subject mismatch).
 *
 * @param callbackUrl the redirect URI the IdP sent the browser to,
 *   including its query (`code`, `state`, optional `iss`)
 */
export async function completeOidcAuthorization(
  config: oidc.Configuration,
  callbackUrl: URL,
  flow: OidcFlowState
): Promise<OidcProfile> {
  const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: flow.codeVerifier,
    expectedState: flow.state,
    expectedNonce: flow.nonce,
    idTokenExpected: true
  })
  const claims = tokens.claims()
  if (!claims) throw new Error('OIDC token response carried no ID token')

  let userinfo: Record<string, unknown> | null = null
  if (config.serverMetadata().userinfo_endpoint) {
    userinfo = { ...await oidc.fetchUserInfo(config, tokens.access_token, claims.sub) }
  }
  return profileFromClaims({ ...claims }, userinfo)
}
