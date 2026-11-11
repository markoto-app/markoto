import type { TraefikProviderSettings } from './config'
import type { LiveCustomDomain } from './routing'

// Traefik dynamic configuration for the live custom domains and the
// pages host — pure, unit-tested. Hostnames come from `normalizeCustomHostname`
// (letters, digits, hyphens, dots), so they can't break out of the
// Host(`…`) rule.

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/
const UPSTREAM_SERVICE = 'markoto-published-pages'

/**
 * Paths the pages host serves (server/middleware/00.custom-domain.ts):
 * the router admits only these, so everything else of the app — internal
 * routes included — never reaches it from the pages host, even before
 * the app's own 404.
 */
const PAGES_HOST_PATHS = 'PathPrefix(`/p/`) || PathPrefix(`/api/published/`) || PathPrefix(`/vendor/`) || Path(`/robots.txt`) || Path(`/favicon.ico`)'

export function buildTraefikDynamicConfig(domains: LiveCustomDomain[], s: TraefikProviderSettings, pagesHost: string | null = null): Record<string, unknown> {
  const routers: Record<string, unknown> = {}
  // The instance's pages host (NUXT_PUBLISH_PAGES_HOST): same edge
  // treatment as a custom domain, with its own certificate. Keep the
  // path list in step with the compose label routers of the pages host.
  if (pagesHost && HOSTNAME_RE.test(pagesHost)) {
    routers['markoto-pages-host'] = {
      rule: `Host(\`${pagesHost}\`) && (${PAGES_HOST_PATHS})`,
      entryPoints: [s.entryPoint],
      service: s.upstream ? UPSTREAM_SERVICE : s.service,
      ...(s.middlewares.length > 0 ? { middlewares: s.middlewares } : {}),
      tls: { certResolver: s.certResolver }
    }
  }
  for (const d of domains) {
    if (!HOSTNAME_RE.test(d.hostname)) continue
    routers[`markoto-domain-${d.id.replace(/[^A-Za-z0-9-]/g, '-')}`] = {
      rule: `Host(\`${d.hostname}\`)`,
      entryPoints: [s.entryPoint],
      service: s.upstream ? UPSTREAM_SERVICE : s.service,
      ...(s.middlewares.length > 0 ? { middlewares: s.middlewares } : {}),
      tls: { certResolver: s.certResolver }
    }
  }
  if (Object.keys(routers).length === 0) return {}
  const http: Record<string, unknown> = { routers }
  if (s.upstream) http.services = { [UPSTREAM_SERVICE]: { loadBalancer: { servers: [{ url: s.upstream }] } } }
  return { http }
}
