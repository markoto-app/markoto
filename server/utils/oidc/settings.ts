// Generic OpenID Connect sign-in — env parsing.
//
// Self-hosters point markoto at their own IdP (Authentik, Keycloak,
// Authelia, Pocket ID, Zitadel, Dex, ...). The provider is offered only
// when issuer + client id + client secret are all set; a partial set is
// a boot error (shared/env/rules/auth.ts), same rule as the GitHub /
// Google pairs.
//
//   NUXT_OAUTH_OIDC_ISSUER         issuer identifier, exactly as the IdP
//                                  publishes it in its discovery document
//   NUXT_OAUTH_OIDC_CLIENT_ID      confidential client registered at the IdP
//   NUXT_OAUTH_OIDC_CLIENT_SECRET
//   NUXT_OAUTH_OIDC_SCOPES         optional, default "openid email profile"
//   NUXT_OAUTH_OIDC_REDIRECT_URL   optional, default <request origin>/auth/oidc
//   NUXT_OAUTH_OIDC_NAME           optional button label ("Continue with <name>"),
//                                  read by `shared/config/instance.ts`
//
// Reads the typed env (shared/env); tests pass an env-shaped record.

import { isTestModeEnabled } from '../../../shared/utils/security/testMode'
import { useEnv } from '~~/shared/env/load'
import type { RawEnv } from '~~/shared/env/define'

const OIDC_DEFAULT_SCOPES = ['openid', 'email', 'profile'] as const

export interface OidcSettings {
  issuer: URL
  clientId: string
  clientSecret: string
  /** Always contains `openid`. */
  scopes: string[]
  /** Explicit callback URL; null = derive from the request origin. */
  redirectUrl: string | null
  /**
   * Plain-http issuer allowed. Only under TEST_MODE=1 (the integration
   * stack's mock IdP) or `NODE_ENV=development`; production requires
   * https because the ID token, the code exchange and the JWKS all ride
   * on it.
   */
  allowInsecureHttp: boolean
  /**
   * Fetch for every request to the IdP (discovery, JWKS, token,
   * UserInfo). Set for per-workspace SSO connections: the issuer
   * is customer-supplied, so requests go through the SSRF policy in
   * `server/utils/sso/urlPolicy.ts`. Unset = global fetch (the
   * operator's own instance IdP).
   */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  /** Separates cache entries of different connections with equal settings. */
  cacheScope?: string
}

export function parseOidcScopes(raw: string | undefined): string[] {
  const parts = (raw ?? '').trim().split(/[\s,]+/).filter(s => s.length > 0)
  const scopes = parts.length > 0 ? parts : [...OIDC_DEFAULT_SCOPES]
  if (!scopes.includes('openid')) scopes.unshift('openid')
  return [...new Set(scopes)]
}

/**
 * The instance's own OIDC provider, or null when it is not configured.
 * Boot validation (shared/env/rules/auth.ts) refuses a partial set, an
 * http issuer outside development / test mode and an issuer with a query
 * or fragment, so a set value here is usable.
 */
export function resolveOidcSettings(source?: RawEnv): OidcSettings | null {
  const env = useEnv(source)
  const { oidcIssuer, oidcClientId, oidcClientSecret, oidcRedirectUrl, oidcScopes } = env.oauth
  if (!oidcIssuer || !oidcClientId || !oidcClientSecret) return null
  const issuer = new URL(oidcIssuer)
  const allowInsecureHttp = isTestModeEnabled(source) || env.core.nodeEnv === 'development'
  if (issuer.protocol !== 'https:' && !(allowInsecureHttp && issuer.protocol === 'http:')) return null
  if (issuer.search || issuer.hash) return null
  return {
    issuer,
    clientId: oidcClientId,
    clientSecret: oidcClientSecret,
    scopes: parseOidcScopes(oidcScopes),
    redirectUrl: oidcRedirectUrl ? new URL(oidcRedirectUrl).toString() : null,
    allowInsecureHttp
  }
}

/**
 * The redirect URI registered at the IdP: `NUXT_OAUTH_OIDC_REDIRECT_URL`,
 * else `<NUXT_SITE_URL>/auth/oidc`. Never derived from the request's Host
 * header (client-controlled); null when neither is configured — boot
 * validation (`oidcRedirectErrors`) refuses that shape.
 */
export function oidcRedirectUri(settings: Pick<OidcSettings, 'redirectUrl'>, siteUrl: unknown): string | null {
  if (settings.redirectUrl) return settings.redirectUrl
  if (typeof siteUrl !== 'string' || siteUrl.trim() === '') return null
  try {
    return new URL('/auth/oidc', siteUrl.trim()).toString()
  } catch {
    return null
  }
}
