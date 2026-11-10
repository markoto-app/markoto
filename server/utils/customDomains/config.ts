import { isTestModeEnabled } from '~~/shared/utils/testMode'

// Instance configuration of custom domains (WP13), read per call so tests
// can stub it. The feature is on only when the operator names the host
// customers point their domain at (`NUXT_PUBLISH_DOMAINS_TARGET`, e.g.
// `pages.markoto.app`) — that host must reach this instance's Traefik.

export interface CustomDomainSettings {
  /** CNAME target customers point to (lowercase, no trailing dot). */
  target: string
  /** DNS servers for the check (`host:port`), empty = the system's. */
  dnsServers: string[]
  /** `.test` names allowed (test stacks only). */
  allowTestNames: boolean
}

export function customDomainSettings(env: NodeJS.ProcessEnv = process.env): CustomDomainSettings | null {
  const target = (env.NUXT_PUBLISH_DOMAINS_TARGET ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!target) return null
  const dnsServers = (env.NUXT_PUBLISH_DNS_SERVERS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return { target, dnsServers, allowTestNames: isTestModeEnabled(env) }
}

export interface TraefikProviderSettings {
  token: string
  entryPoint: string
  certResolver: string
  /** An existing Traefik service (`app@docker`) … */
  service: string
  /** … or an upstream URL the endpoint declares a service for (test stacks). */
  upstream: string | null
  middlewares: string[]
}

/** Settings of the Traefik HTTP-provider endpoint; null = endpoint off (404). */
export function traefikProviderSettings(env: NodeJS.ProcessEnv = process.env): TraefikProviderSettings | null {
  const token = (env.NUXT_PUBLISH_TRAEFIK_TOKEN ?? '').trim()
  if (token.length < 32) return null
  const list = (v: string | undefined) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return {
    token,
    entryPoint: env.NUXT_PUBLISH_TRAEFIK_ENTRYPOINT?.trim() || 'websecure',
    certResolver: env.NUXT_PUBLISH_TRAEFIK_CERT_RESOLVER?.trim() || 'le',
    service: env.NUXT_PUBLISH_TRAEFIK_SERVICE?.trim() || 'app@docker',
    upstream: env.NUXT_PUBLISH_TRAEFIK_UPSTREAM?.trim() || null,
    middlewares: list(env.NUXT_PUBLISH_TRAEFIK_MIDDLEWARES)
  }
}
