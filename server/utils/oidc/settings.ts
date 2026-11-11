// Generic OpenID Connect sign-in (WP7b) — env parsing.
//
// Self-hosters point markoto at their own IdP (Authentik, Keycloak,
// Authelia, Pocket ID, Zitadel, Dex, ...). The provider is offered only
// when issuer + client id + client secret are all set; a partial set is
// a boot error (`server/plugins/01-validate-secrets.ts`), same rule as
// the GitHub / Google pairs.
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
// Pure — takes an env-shaped record so every test tier can drive it.

import { isTestModeEnabled } from '../../../shared/utils/testMode'

type Env = Record<string, string | undefined>

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
   * UserInfo). Set for per-workspace SSO connections (WP14): the issuer
   * is customer-supplied, so requests go through the SSRF policy in
   * `server/utils/sso/urlPolicy.ts`. Unset = global fetch (the
   * operator's own instance IdP).
   */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  /** Separates cache entries of different connections with equal settings. */
  cacheScope?: string
}

export interface OidcSettingsResult {
  /** Null when OIDC is not configured (or misconfigured — see `errors`). */
  settings: OidcSettings | null
  /** Human-readable configuration errors; non-empty fails boot. */
  errors: string[]
}

function trimmed(raw: string | undefined): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

export function parseOidcScopes(raw: string | undefined): string[] {
  const parts = trimmed(raw).split(/[\s,]+/).filter(s => s.length > 0)
  const scopes = parts.length > 0 ? parts : [...OIDC_DEFAULT_SCOPES]
  if (!scopes.includes('openid')) scopes.unshift('openid')
  return [...new Set(scopes)]
}

function insecureHttpAllowed(env: Env): boolean {
  return isTestModeEnabled(env) || env.NODE_ENV === 'development'
}

function parseIssuer(raw: string, allowInsecureHttp: boolean, errors: string[]): URL | null {
  let issuer: URL
  try {
    issuer = new URL(raw)
  } catch {
    errors.push(`NUXT_OAUTH_OIDC_ISSUER is not a valid URL: "${raw}"`)
    return null
  }
  if (issuer.protocol !== 'https:' && !(allowInsecureHttp && issuer.protocol === 'http:')) {
    errors.push(`NUXT_OAUTH_OIDC_ISSUER must use https: (got "${issuer.protocol}")`)
    return null
  }
  if (issuer.search || issuer.hash) {
    errors.push('NUXT_OAUTH_OIDC_ISSUER must not contain a query string or fragment')
    return null
  }
  return issuer
}

function parseRedirectUrl(raw: string, errors: string[]): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      errors.push(`NUXT_OAUTH_OIDC_REDIRECT_URL must use http(s): (got "${url.protocol}")`)
      return null
    }
    return url.toString()
  } catch {
    errors.push(`NUXT_OAUTH_OIDC_REDIRECT_URL is not a valid URL: "${raw}"`)
    return null
  }
}

export function resolveOidcSettings(env: Env): OidcSettingsResult {
  const issuerRaw = trimmed(env.NUXT_OAUTH_OIDC_ISSUER)
  const clientId = trimmed(env.NUXT_OAUTH_OIDC_CLIENT_ID)
  const clientSecret = trimmed(env.NUXT_OAUTH_OIDC_CLIENT_SECRET)
  const present = [issuerRaw, clientId, clientSecret].filter(v => v.length > 0).length
  if (present === 0) return { settings: null, errors: [] }

  const errors: string[] = []
  if (present !== 3) {
    errors.push(
      'NUXT_OAUTH_OIDC_ISSUER, NUXT_OAUTH_OIDC_CLIENT_ID and NUXT_OAUTH_OIDC_CLIENT_SECRET must be set together '
      + `(got: issuer=${issuerRaw ? 'set' : 'empty'}, id=${clientId ? 'set' : 'empty'}, secret=${clientSecret ? 'set' : 'empty'})`
    )
    return { settings: null, errors }
  }

  const allowInsecureHttp = insecureHttpAllowed(env)
  const issuer = parseIssuer(issuerRaw, allowInsecureHttp, errors)
  const redirectUrl = parseRedirectUrl(trimmed(env.NUXT_OAUTH_OIDC_REDIRECT_URL), errors)
  if (!issuer || errors.length > 0) return { settings: null, errors }

  return {
    settings: {
      issuer,
      clientId,
      clientSecret,
      scopes: parseOidcScopes(env.NUXT_OAUTH_OIDC_SCOPES),
      redirectUrl,
      allowInsecureHttp
    },
    errors
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

/** Boot-time error when OIDC is configured but no redirect URI can be built. */
export function oidcRedirectErrors(settings: Pick<OidcSettings, 'redirectUrl'> | null, siteUrl: unknown): string[] {
  if (!settings || oidcRedirectUri(settings, siteUrl) !== null) return []
  return ['OpenID Connect sign-in needs NUXT_OAUTH_OIDC_REDIRECT_URL or NUXT_SITE_URL (the redirect URI is never taken from the request Host header)']
}
