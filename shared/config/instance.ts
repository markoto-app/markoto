// Instance shape: what THIS deployment offers beyond the editor itself.
//
// Same idea as `billingMode.ts`: one codebase, the deployment shape is
// configuration. Two independent facts live here:
//
// 1. Login providers. GitHub / Google OAuth via nuxt-auth-utils, plus a
//    generic OpenID Connect provider for self-hosters' own IdPs
//    (`server/routes/auth/oidc.get.ts`). A provider is offered only when
//    its credentials are complete: client id + secret (GitHub, Google),
//    issuer + client id + secret (OIDC). A self-hosted instance without
//    any is anonymous-only (public docs work; ownership, workspaces and
//    AI need an account), and the UI must not offer buttons that end in
//    a 500.
//
// 2. Legal surfaces: the onboarding gate (age + Privacy + ToS), the
//    cookie-consent banner, the DPA acceptance step for workspace owners,
//    the /legal/* pages (privacy, terms, DPA, sub-processors, abuse
//    policy + form, imprint) and the footer links to them. The bundled
//    texts describe the HOSTED markoto.app service operated by
//    LatentSpace Labs GmbH. A self-hoster is their own operator, so the
//    default is OFF; the hosted SaaS turns them on via its env
//    (`infra/render-env.sh`, prod compose).
//
//   | Shape                         | NUXT_LEGAL_SURFACES_ENABLED |
//   |-------------------------------|-----------------------------|
//   | Self-hosted (default)         | false                       |
//   | Hosted SaaS                   | true                        |
//
// 3. Marketing site: "this instance IS markoto.app". Turns on the
//    scroll-driven product page at `/` for logged-out visitors
//    (`app/components/landing/ProductTour.vue`), the sitemap
//    (`server/routes/sitemap.xml.ts`), the `Sitemap:` line in robots.txt,
//    the JSON-LD on `/` and the `marketing-pages` route middleware for
//    hosted-only pages. OFF by default; markoto.app sets
//    NUXT_MARKETING_SITE_ENABLED=true. Self-hosted instances keep the
//    plain hero + "new document" page.
//
// 4. SEO facts: the public origin for canonical / og:url / JSON-LD
//    (`NUXT_CANONICAL_SITE_URL`, else `NUXT_SITE_URL`), where `/docs/**` canonicals point (`NUXT_DOCS_CANONICAL_BASE`)
//    and whether search engines may index the instance at all
//    (`NUXT_SITE_INDEXABLE`, server-only: staging renders false).
//
// Reads the typed env (shared/env); tests pass an env-shaped record.

import { resolveBillingMode } from './billingMode'
import { useEnv } from '../env/load'
import type { RawEnv } from '../env/define'
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
   * `https://markoto.app`: also on staging), no trailing slash. Empty
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
   * Per-workspace single sign-on can exist here: a plan that can
   * be on this instance includes it, with billing off only the free
   * tier, with billing on any plan. Shows "Sign in with your
   * organisation" on the sign-in screen.
   */
  workspaceSso: boolean
  /**
   * The operator set up custom domains for published pages
   * (`NUXT_PUBLISH_DOMAINS_TARGET`). Whether a user may add one is a
   * separate, per-plan question (`customDomains` feature).
   */
  customDomains: boolean
  /** Co-branding of a managed private instance (`shared/config/instanceBrand.ts`). */
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

export function resolveLoginProviders(source?: RawEnv): LoginProvider[] {
  const { oauth } = useEnv(source)
  const configured: Record<LoginProvider, boolean> = {
    oidc: !!(oauth.oidcIssuer && oauth.oidcClientId && oauth.oidcClientSecret),
    github: !!(oauth.githubClientId && oauth.githubClientSecret),
    google: !!(oauth.googleClientId && oauth.googleClientSecret)
  }
  return LOGIN_PROVIDERS.filter(p => configured[p])
}

export function resolveLegalSurfacesEnabled(source?: RawEnv): boolean {
  return useEnv(source).legal.surfacesEnabled
}

export function resolveMarketingSiteEnabled(source?: RawEnv): boolean {
  return useEnv(source).core.marketingSite
}

/** Origin of a validated http(s) URL, '' when unset. */
function originOf(value: string | undefined): string {
  return value ? new URL(value).origin : ''
}

/** `NUXT_SITE_URL` as an origin, '' when unset. */
export function resolveSiteUrl(source?: RawEnv): string {
  return originOf(useEnv(source).core.siteUrl)
}

/**
 * Origin the SEO tags name, canonical links, og:url / og:image, the
 * JSON-LD and the sitemap: `NUXT_CANONICAL_SITE_URL` when set, otherwise
 * this instance's own `NUXT_SITE_URL`. Staging renders
 * `https://markoto.app`, so a copy of the site on staging.markoto.app
 * points search engines at the real one instead of competing with it.
 */
export function resolveCanonicalSiteUrl(source?: RawEnv): string {
  const { core } = useEnv(source)
  return originOf(core.canonicalSiteUrl) || originOf(core.siteUrl)
}

/**
 * Origin for `/docs/**` canonicals; '' = this instance's own site URL.
 * The marketing site is the original, so it is always self-canonical.
 * Elsewhere: `NUXT_DOCS_CANONICAL_BASE` when set (an empty value opts
 * into self-canonical docs), otherwise markoto.app.
 */
export function resolveDocsCanonicalBase(source?: RawEnv): string {
  const { core } = useEnv(source)
  if (core.marketingSite) return ''
  if (core.docsCanonicalBase === undefined) return DEFAULT_DOCS_CANONICAL_BASE
  return originOf(core.docsCanonicalBase)
}

/**
 * `NUXT_SITE_INDEXABLE`: may search engines index this instance?
 * Default true; false = robots.txt `Disallow: /` + `X-Robots-Tag:
 * noindex` on every response. Staging renders false.
 */
export function resolveSiteIndexable(source?: RawEnv): boolean {
  return useEnv(source).core.siteIndexable
}

export function resolveInstanceConfig(source?: RawEnv): InstanceConfig {
  const env = useEnv(source)
  const legalSurfaces = env.legal.surfacesEnabled
  return {
    loginProviders: resolveLoginProviders(source),
    oidcProviderName: env.oauth.oidcName.slice(0, OIDC_PROVIDER_NAME_MAX_LENGTH),
    legalSurfaces,
    operatorName: legalSurfaces
      ? resolveLegalEntity(source).controllerName
      : (env.legal.controllerName ?? ''),
    marketingSite: env.core.marketingSite,
    siteUrl: resolveCanonicalSiteUrl(source),
    docsCanonicalBase: resolveDocsCanonicalBase(source),
    anonGate: resolveAnonGateEnabled(source),
    anonDocTtlDays: resolveAnonDocTtlDays(source),
    workspaceSso: resolveWorkspaceSsoAvailable(source),
    customDomains: !!env.publish.domainsTarget,
    brand: resolveInstanceBrand(source)
  }
}

/** See `InstanceConfig.workspaceSso`. */
export function resolveWorkspaceSsoAvailable(source?: RawEnv): boolean {
  const tiers = resolveTiersFromEnv(source)
  if (!resolveBillingMode(source).billingEnabled) return tiers.free.sso
  return Object.values(tiers).some(caps => caps.sso)
}

/** Path that starts the sign-in flow for a provider. */
export function loginPath(provider: LoginProvider): string {
  return `/auth/${provider}`
}
