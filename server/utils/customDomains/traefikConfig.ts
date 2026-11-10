import type { TraefikProviderSettings } from './config'
import type { LiveCustomDomain } from './routing'

// Traefik dynamic configuration for the live custom domains (WP13) —
// pure, unit-tested. Hostnames come from `normalizeCustomHostname`
// (letters, digits, hyphens, dots), so they can't break out of the
// Host(`…`) rule.

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/
const UPSTREAM_SERVICE = 'markoto-published-pages'

export function buildTraefikDynamicConfig(domains: LiveCustomDomain[], s: TraefikProviderSettings): Record<string, unknown> {
  const routers: Record<string, unknown> = {}
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
