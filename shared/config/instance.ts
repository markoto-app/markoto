// Instance shape — what THIS deployment offers beyond the editor itself.
//
// Same idea as `billingMode.ts`: one codebase, the deployment shape is
// configuration. Two independent facts live here:
//
// 1. Login providers. Login is GitHub / Google OAuth via nuxt-auth-utils;
//    a provider is offered only when both its client id and secret are
//    set. A self-hosted instance without OAuth apps is anonymous-only
//    (public docs work; ownership, workspaces and AI need an account),
//    and the UI must not offer buttons that end in a 500.
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
// Pure — takes an env-shaped record so every test tier can drive it.

import { parseBooleanFlag } from './billingMode'
import { resolveLegalEntity } from '../legal/entity'

export type LoginProvider = 'github' | 'google'

export const LOGIN_PROVIDERS: readonly LoginProvider[] = ['github', 'google']

export interface InstanceConfig {
  /** OAuth providers with a complete client id + secret, in display order. */
  loginProviders: LoginProvider[]
  /** Onboarding gate, consent banner, DPA step, /legal/* pages + footer links. */
  legalSurfaces: boolean
  /**
   * Who runs this instance, for the footer. The legal entity's name while
   * legal surfaces are on; otherwise only an explicitly configured
   * `NUXT_LEGAL_CONTROLLER_NAME` (never the hosted operator's default).
   * Empty = show nothing operator-specific.
   */
  operatorName: string
}

/** Client-side fallback before hydration: nothing optional is offered. */
export const MINIMAL_INSTANCE_CONFIG: InstanceConfig = Object.freeze({
  loginProviders: [],
  legalSurfaces: false,
  operatorName: ''
})

type Env = Record<string, string | undefined>

function isSet(raw: string | undefined): boolean {
  return typeof raw === 'string' && raw.trim().length > 0
}

export function resolveLoginProviders(env: Env): LoginProvider[] {
  return LOGIN_PROVIDERS.filter((p) => {
    const upper = p.toUpperCase()
    return isSet(env[`NUXT_OAUTH_${upper}_CLIENT_ID`]) && isSet(env[`NUXT_OAUTH_${upper}_CLIENT_SECRET`])
  })
}

export function resolveLegalSurfacesEnabled(env: Env): boolean {
  return parseBooleanFlag(env.NUXT_LEGAL_SURFACES_ENABLED)
}

export function resolveInstanceConfig(env: Env): InstanceConfig {
  const legalSurfaces = resolveLegalSurfacesEnabled(env)
  return {
    loginProviders: resolveLoginProviders(env),
    legalSurfaces,
    operatorName: legalSurfaces
      ? resolveLegalEntity(env).controllerName
      : (env.NUXT_LEGAL_CONTROLLER_NAME?.trim() ?? '')
  }
}

/** Path that starts the OAuth flow for a provider. */
export function loginPath(provider: LoginProvider): string {
  return `/auth/${provider}`
}
