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
// 3. Product tour — the scroll-driven product page shown at `/` to
//    logged-out visitors (WP11, `app/components/landing/ProductTour.vue`).
//    It markets the hosted service, so it is OFF by default; markoto.app
//    turns it on with NUXT_PRODUCT_TOUR_ENABLED=true. Self-hosted
//    instances keep the plain hero + "new document" page.
//
// Pure — takes an env-shaped record so every test tier can drive it.

import { parseBooleanFlag } from './billingMode'
import { resolveLegalEntity } from '../legal/entity'

export type LoginProvider = 'oidc' | 'github' | 'google'

/**
 * Display order. The operator's own IdP comes first: an instance that
 * configured one wants it to be the primary sign-in (it is also what
 * `primaryLoginPath` picks for "log in to continue" redirects).
 */
export const LOGIN_PROVIDERS: readonly LoginProvider[] = ['oidc', 'github', 'google']

/** Upper bound for `NUXT_OAUTH_OIDC_NAME` on the sign-in button. */
export const OIDC_PROVIDER_NAME_MAX_LENGTH = 40

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
  /** Scroll-driven product page at `/` for logged-out visitors (hosted only). */
  productTour: boolean
}

/** Client-side fallback before hydration: nothing optional is offered. */
export const MINIMAL_INSTANCE_CONFIG: InstanceConfig = Object.freeze({
  loginProviders: [],
  oidcProviderName: '',
  legalSurfaces: false,
  operatorName: '',
  productTour: false
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

export function resolveOidcProviderName(env: Env): string {
  return (env.NUXT_OAUTH_OIDC_NAME ?? '').trim().slice(0, OIDC_PROVIDER_NAME_MAX_LENGTH)
}

export function resolveLegalSurfacesEnabled(env: Env): boolean {
  return parseBooleanFlag(env.NUXT_LEGAL_SURFACES_ENABLED)
}

export function resolveProductTourEnabled(env: Env): boolean {
  return parseBooleanFlag(env.NUXT_PRODUCT_TOUR_ENABLED)
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
    productTour: resolveProductTourEnabled(env)
  }
}

/** Path that starts the sign-in flow for a provider. */
export function loginPath(provider: LoginProvider): string {
  return `/auth/${provider}`
}
