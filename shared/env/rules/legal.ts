import type { Rule } from '../define'
import type { AppEnv } from '../namespaces'

/** Is the anonymous gate on? Explicit NUXT_ANON_GATE_ENABLED wins, else it follows the legal surfaces. */
export function anonGateOn(env: AppEnv): boolean {
  return env.legal.anonGateEnabled ?? env.legal.surfacesEnabled
}

export const legalRules: Rule<AppEnv>[] = [
  {
    services: ['app'],
    relaxedInTestMode: true,
    vars: ['NUXT_LEGAL_SURFACES_ENABLED', 'NUXT_LEGAL_CONTROLLER_ADDRESS', 'NUXT_LEGAL_REPRESENTED_BY'],
    doc: 'The legal pages need the operator\'s postal address and representative.',
    check: (env) => {
      if (!env.legal.surfacesEnabled) return []
      const errors: string[] = []
      if (!env.legal.controllerAddress) {
        errors.push('NUXT_LEGAL_CONTROLLER_ADDRESS is required when NUXT_LEGAL_SURFACES_ENABLED=true (the legal pages need a postal address)')
      }
      if (!env.legal.representedBy) {
        errors.push('NUXT_LEGAL_REPRESENTED_BY is required when NUXT_LEGAL_SURFACES_ENABLED=true (the Impressum names the authorised representative)')
      }
      return errors
    }
  },
  {
    services: ['app'],
    relaxedInTestMode: true,
    vars: ['NUXT_LEGAL_SURFACES_ENABLED', 'NUXT_AI_BYOK_ALLOWED_BASE_URLS'],
    doc: 'The hosted shape restricts user-supplied AI provider URLs to an allowlist.',
    check: env => env.legal.surfacesEnabled && env.ai.byokAllowedBaseUrls.length === 0
      ? ['NUXT_AI_BYOK_ALLOWED_BASE_URLS is empty, but this instance runs the hosted shape (NUXT_LEGAL_SURFACES_ENABLED=true): set the provider allowlist (see infra/render-env.sh) so user-supplied AI provider URLs are restricted']
      : []
  },
  {
    services: ['app'],
    relaxedInTestMode: true,
    vars: ['NUXT_LEGAL_SURFACES_ENABLED', 'NUXT_PUBLISH_PAGES_HOST', 'NUXT_PUBLISH_TRAEFIK_TOKEN'],
    doc: 'The hosted shape serves published pages from their own host, routed through the token-protected Traefik provider.',
    check: (env) => {
      if (!env.legal.surfacesEnabled) return []
      if (!env.publish.pagesHost) {
        return ['NUXT_PUBLISH_PAGES_HOST is empty, but this instance runs the hosted shape (NUXT_LEGAL_SURFACES_ENABLED=true): published pages must be served from their own hostname (e.g. pages.<your domain>), never the app\'s origin']
      }
      if (!env.publish.traefikToken) {
        return ['NUXT_PUBLISH_PAGES_HOST is set but NUXT_PUBLISH_TRAEFIK_TOKEN is missing: Traefik learns the pages host\'s router and certificate from the app\'s HTTP provider, which only answers with the token']
      }
      return []
    }
  },
  {
    services: ['app'],
    relaxedInTestMode: true,
    vars: ['NUXT_ANON_GATE_ENABLED', 'NUXT_LEGAL_SURFACES_ENABLED', 'NUXT_ALTCHA_HMAC_KEY'],
    doc: 'The anonymous gate needs its ALTCHA key.',
    check: env => anonGateOn(env) && !env.legal.altchaHmacKey
      ? ['NUXT_ALTCHA_HMAC_KEY is required while the anonymous gate is on (NUXT_ANON_GATE_ENABLED, default: NUXT_LEGAL_SURFACES_ENABLED)']
      : []
  }
]
