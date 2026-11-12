import { isTestModeEnabled } from '~~/shared/utils/security/testMode'
import { useEnv } from '~~/shared/env/load'
import type { RawEnv } from '~~/shared/env/define'

// Instance configuration of custom domains, read per call so tests
// can stub it. The feature is on only when the operator names the host
// customers point their domain at (`NUXT_PUBLISH_DOMAINS_TARGET`, e.g.
// `pages.markoto.app`): that host must reach this instance's Traefik.

export interface CustomDomainSettings {
  /** CNAME target customers point to (lowercase, no trailing dot). */
  target: string
  /** DNS servers for the check (`host:port`), empty = the system's. */
  dnsServers: string[]
  /** `.test` names allowed (test stacks only). */
  allowTestNames: boolean
}

export function customDomainSettings(source?: RawEnv): CustomDomainSettings | null {
  const { publish } = useEnv(source)
  const target = (publish.domainsTarget ?? '').toLowerCase().replace(/\.$/, '')
  if (!target) return null
  return { target, dnsServers: [...publish.dnsServers], allowTestNames: isTestModeEnabled(source) }
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
  /**
   * Also emit the router of the pages host (NUXT_PUBLISH_PAGES_HOST). On
   * for the self-host HTTPS overlay, where the pages host is optional and
   * compose labels can't express an optional router; the hosted stack
   * declares its pages router as a compose label instead.
   */
  pagesRouter: boolean
}

/** Settings of the Traefik HTTP-provider endpoint; null = endpoint off (404). */
export function traefikProviderSettings(source?: RawEnv): TraefikProviderSettings | null {
  const { publish } = useEnv(source)
  if (!publish.traefikToken) return null
  return {
    token: publish.traefikToken,
    entryPoint: publish.traefikEntryPoint,
    certResolver: publish.traefikCertResolver,
    service: publish.traefikService,
    upstream: publish.traefikUpstream ?? null,
    middlewares: [...publish.traefikMiddlewares],
    pagesRouter: publish.traefikPagesRouter
  }
}
