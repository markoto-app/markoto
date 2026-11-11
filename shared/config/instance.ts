// Instance shape — what THIS deployment offers beyond the editor itself.
//
// Same idea as `billingMode.ts`: one codebase, the deployment shape is
// configuration. Two independent facts live here:
//
// 1. Login providers. GitHub / Google OAuth via nuxt-auth-utils, plus a
//    generic OpenID Connect provider for self-hosters' own IdPs (WP7b,
//    `server/routes/auth/oidc.get.ts`). A provider is offered only when
//    its credentials are complete: client id + secret (GitHub, Google),
//    issuer + client id + secret (OIDC). A self-hosted instance without
//    any is anonymous-only (public docs work; ownership, workspaces and
//    AI need an account), and the UI must not offer buttons that end in
//    a 500.
//
// 2. Legal surfaces — the onboarding gate (age + Privacy + ToS), the
//    cookie-consent banner, the DPA acceptance step for workspace owners,
//    the /legal/* pages (privacy, terms, DPA, sub-processors, abuse
//    policy + form, imprint) and the footer links to them. The bundled
//    texts describe the HOSTED markoto.app service operated by
//    LatentSpace Labs GmbH. A self-hoster is their own operator, so the
//    default is OFF; the hosted SaaS turns them on via its env
//    (`infra/render-env.sh`, `infra/templates/env.j2`, prod compose).
//
//   | Shape                         | NUXT_LEGAL_SURFACES_ENABLED |
//   |-------------------------------|-----------------------------|
//   | Self-hosted (default)         | false                       |
//   | Hosted SaaS                   | true                        |
//
// 3. Marketing site — "this instance IS markoto.app". Turns on the
//    scroll-driven product page at `/` for logged-out visitors (WP11,
//    `app/components/landing/ProductTour.vue`), the sitemap
//    (`server/routes/sitemap.xml.ts`), the `Sitemap:` line in robots.txt,
//    the JSON-LD on `/` and the `marketing-pages` route middleware for
//    hosted-only pages. OFF by default; markoto.app sets
//    NUXT_MARKETING_SITE_ENABLED=true. Self-hosted instances keep the
//    plain hero + "new document" page.
//
// 4. SEO facts — the public origin for canonical / og:url / JSON-LD
//    (`NUXT_CANONICAL_SITE_URL`, else `NUXT_SITE_URL`), where `/docs/**` canonicals point (`NUXT_DOCS_CANONICAL_BASE`)
//    and whether search engines may index the instance at all
//    (`NUXT_SITE_INDEXABLE`, server-only — staging renders false).
//
// Pure — takes an env-shaped record so every test tier can drive it.

import { parseBooleanFlag, resolveBillingMode } from './billingMode'
import { EMPTY_INSTANCE_BRAND, resolveInstanceBrand, type InstanceBrand } from './instanceBrand'
import { resolveTiersFromEnv } from './tiers'
import { resolveLegalEntity } from '../legal/entity'
import { DEFAULT_ANON_DOC_TTL_DAYS, resolveAnonDocTtlDays, resolveAnonGateEnabled } from './anonGate'

export type LoginProvider = 'oidc' | 'github' | 'google'

/**
 * Display order. The operator's own IdP comes first: an instance that
 * configured one wants it to be the primary sign-in (it is also what
 * `primaryLoginPath` picks for "log in to continue" redirects).
 */
const LOGIN_PROVIDERS: readonly LoginProvider[] = ['oidc', 'github', 'google']

/** Upper bound for `NUXT_OAUTH_OIDC_NAME` on the sign-in button. */
const OIDC_PROVIDER_NAME_MAX_LENGTH = 40

export interface InstanceConfig {
  /** Login providers with complete credentials, in display order. */
  loginProviders: LoginProvider[]
  /**
   * Button label for the OIDC provider (`NUXT_OAUTH_OIDC_NAME`, e.g.
   * "Authentik"). Empty = the UI's generic "single sign-on" wording.
   */
  oidcProviderName: string
  /** Onboarding gate, consent banner, DPA step, /legal/* pages + footer links. */
  legalSurfaces: boolean
  /**
   * Who runs this instance, for the footer. The legal entity's name while
   * legal surfaces are on; otherwise only an explicitly configured
   * `NUXT_LEGAL_CONTROLLER_NAME` (never the hosted operator's default).
   * Empty = show nothing operator-specific.
   */
  operatorName: string
  /**
   * This instance is the hosted marketing site (markoto.app): product
   * tour at `/`, sitemap, JSON-LD, hosted-only marketing pages.
   */
  marketingSite: boolean
  /**
   * Public origin the SEO tags name (`resolveCanonicalSiteUrl`:
   * `NUXT_CANONICAL_SITE_URL`, else `NUXT_SITE_URL`; e.g.
   * `https://markoto.app` — also on staging), no trailing slash. Empty
   * when unset/invalid: no canonical / og:url is emitted then. Never
   * derived from the request Host. Not for links in emails (those use
   * the runtime config's own site URL).
   */
  siteUrl: string
  /**
   * Origin that `/docs/**` canonicals point to. Empty = the instance's
   * own `siteUrl`. Self-hosted instances default to markoto.app so their
   * bundled copy of the docs does not compete with the original.
   */
  docsCanonicalBase: string
  /**
   * Anonymous visitors pass the bot check + accept the terms before their
   * first document and may report content without signing in
   * (`shared/config/anonGate.ts`).
   */
  anonGate: boolean
  /** Days without activity after which anonymous documents are deleted (0 = never). */
  anonDocTtlDays: number
  /**
   * Per-workspace single sign-on can exist here (WP14): a plan that can
   * be on this instance includes it — with billing off only the free
   * tier, with billing on any plan. Shows "Sign in with your
   * organisation" on the sign-in screen.
   */
  workspaceSso: boolean
  /**
   * The operator set up custom domains for published pages (WP13,
   * `NUXT_PUBLISH_DOMAINS_TARGET`). Whether a user may add one is a
   * separate, per-plan question (`customDomains` feature).
   */
  customDomains: boolean
  /** Co-branding of a managed private instance (WP16, `shared/config/instanceBrand.ts`). */
  brand: InstanceBrand
}

/** Where self-hosted instances point their `/docs/**` canonicals. */
export const DEFAULT_DOCS_CANONICAL_BASE = 'https://markoto.app'

/** Client-side fallback before hydration: nothing optional is offered. */
export const MINIMAL_INSTANCE_CONFIG: InstanceConfig = Object.freeze({
  loginProviders: [],
  oidcProviderName: '',
  legalSurfaces: false,
  operatorName: '',
  marketingSite: false,
  siteUrl: '',
  docsCanonicalBase: DEFAULT_DOCS_CANONICAL_BASE,
  anonGate: false,
  anonDocTtlDays: DEFAULT_ANON_DOC_TTL_DAYS,
  workspaceSso: false,
  customDomains: false,
  brand: EMPTY_INSTANCE_BRAND
})

type Env = Record<string, string | undefined>

function isSet(raw: string | undefined): boolean {
  return typeof raw === 'string' && raw.trim().length > 0
}

export function resolveLoginProviders(env: Env): LoginProvider[] {
  return LOGIN_PROVIDERS.filter((p) => {
    const upper = p.toUpperCase()
    const pair = isSet(env[`NUXT_OAUTH_${upper}_CLIENT_ID`]) && isSet(env[`NUXT_OAUTH_${upper}_CLIENT_SECRET`])
    return p === 'oidc' ? pair && isSet(env.NUXT_OAUTH_OIDC_ISSUER) : pair
  })
}

function resolveOidcProviderName(env: Env): string {
  return (env.NUXT_OAUTH_OIDC_NAME ?? '').trim().slice(0, OIDC_PROVIDER_NAME_MAX_LENGTH)
}

export function resolveLegalSurfacesEnabled(env: Env): boolean {
  return parseBooleanFlag(env.NUXT_LEGAL_SURFACES_ENABLED)
}

export function resolveMarketingSiteEnabled(env: Env): boolean {
  return parseBooleanFlag(env.NUXT_MARKETING_SITE_ENABLED)
}

/** http(s) origin of a URL string, or '' when empty / invalid. */
function originOf(raw: string | undefined): string {
  const value = raw?.trim() ?? ''
  if (!value) return ''
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : ''
  } catch {
    return ''
  }
}

/** `NUXT_SITE_URL` as an origin, '' when unset or invalid. */
export function resolveSiteUrl(env: Env): string {
  return originOf(env.NUXT_SITE_URL)
}

/**
 * Origin the SEO tags name — canonical links, og:url / og:image, the
 * JSON-LD and the sitemap: `NUXT_CANONICAL_SITE_URL` when set to a valid
 * origin, otherwise this instance's own `NUXT_SITE_URL`. Staging renders
 * `https://markoto.app`, so a copy of the site on staging.markoto.app
 * points search engines at the real one instead of competing with it.
 */
export function resolveCanonicalSiteUrl(env: Env): string {
  return originOf(env.NUXT_CANONICAL_SITE_URL) || resolveSiteUrl(env)
}

/**
 * Origin for `/docs/**` canonicals; '' = this instance's own site URL.
 * The marketing site is the original, so it is always self-canonical.
 * Elsewhere: `NUXT_DOCS_CANONICAL_BASE` when set (an empty value opts
 * into self-canonical docs), otherwise markoto.app. An unparsable value
 * falls back to markoto.app.
 */
export function resolveDocsCanonicalBase(env: Env): string {
  if (resolveMarketingSiteEnabled(env)) return ''
  const raw = env.NUXT_DOCS_CANONICAL_BASE
  if (raw === undefined) return DEFAULT_DOCS_CANONICAL_BASE
  if (raw.trim() === '') return ''
  return originOf(raw) || DEFAULT_DOCS_CANONICAL_BASE
}

const FALSY = new Set(['0', 'false', 'no', 'off'])

/**
 * `NUXT_SITE_INDEXABLE` — may search engines index this instance?
 * Default true; only an explicit `0` / `false` / `no` / `off` turns it
 * off (robots.txt `Disallow: /` + `X-Robots-Tag: noindex` on every
 * response). Staging renders false. A typo keeps the site indexable, so
 * production can never drop out of search by accident.
 */
export function resolveSiteIndexable(env: Env): boolean {
  const raw = env.NUXT_SITE_INDEXABLE
  if (raw === undefined) return true
  return !FALSY.has(raw.trim().toLowerCase())
}

export function resolveInstanceConfig(env: Env): InstanceConfig {
  const legalSurfaces = resolveLegalSurfacesEnabled(env)
  return {
    loginProviders: resolveLoginProviders(env),
    oidcProviderName: resolveOidcProviderName(env),
    legalSurfaces,
    operatorName: legalSurfaces
      ? resolveLegalEntity(env).controllerName
      : (env.NUXT_LEGAL_CONTROLLER_NAME?.trim() ?? ''),
    marketingSite: resolveMarketingSiteEnabled(env),
    siteUrl: resolveCanonicalSiteUrl(env),
    docsCanonicalBase: resolveDocsCanonicalBase(env),
    anonGate: resolveAnonGateEnabled(env),
    anonDocTtlDays: resolveAnonDocTtlDays(env),
    workspaceSso: resolveWorkspaceSsoAvailable(env),
    customDomains: (env.NUXT_PUBLISH_DOMAINS_TARGET ?? '').trim() !== '',
    brand: resolveInstanceBrand(env)
  }
}

/** See `InstanceConfig.workspaceSso`. */
export function resolveWorkspaceSsoAvailable(env: Env): boolean {
  const tiers = resolveTiersFromEnv(env)
  if (!resolveBillingMode(env).billingEnabled) return tiers.free.sso
  return Object.values(tiers).some(caps => caps.sso)
}

/** Path that starts the sign-in flow for a provider. */
export function loginPath(provider: LoginProvider): string {
  return `/auth/${provider}`
}
