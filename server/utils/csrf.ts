// Origin check for state-changing API requests — defence in depth on top
// of the `SameSite=Lax` session cookie. SameSite only separates SITES:
// another origin on the same registrable domain (a sibling subdomain, a
// staging host) still counts as same-site and gets the cookie. Browsers
// stamp every cross-origin POST/PUT/PATCH/DELETE with `Origin` (and
// `Sec-Fetch-Site`), so we require it to name this instance.
//
// Rules, for POST/PUT/PATCH/DELETE on `/api/*`:
//   1. `Origin` present → its host must equal the request `Host` or the
//      host of `NUXT_SITE_URL`. `Origin: null` (sandboxed / opaque
//      contexts) is refused.
//   2. else `Sec-Fetch-Site` present → only `same-origin` / `none`.
//   3. else `Referer` present → same host rule as 1.
//   4. else allow — no browser sends a state-changing request with none of
//      the three; non-browser clients (CLI, server-to-server) carry no
//      ambient cookies to abuse.
//
// Exempt: webhooks (Stripe, signature-verified) and the internal
// shared-secret endpoints — server-to-server, never cookie-authenticated.
// MCP (`/mcp`, bearer tokens) and the OAuth callbacks (`/auth/*`, GET)
// are outside `/api` and unaffected.

export const CSRF_ORIGIN_CODE = 'csrf/origin-mismatch'

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const EXEMPT_PATHS: RegExp[] = [
  /^\/api\/webhooks\//,
  /^\/api\/internal\//
]

export interface OriginCheckInput {
  method: string
  path: string
  origin: string | undefined
  referer: string | undefined
  secFetchSite: string | undefined
  host: string | undefined
  siteUrl: string | undefined
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.host.toLowerCase()
  } catch {
    return null
  }
}

function allowedHosts(input: OriginCheckInput): Set<string> {
  const hosts = new Set<string>()
  if (input.host) hosts.add(input.host.trim().toLowerCase())
  const site = input.siteUrl ? hostOf(input.siteUrl) : null
  if (site) hosts.add(site)
  return hosts
}

/** True when the request may proceed. */
export function isRequestOriginAllowed(input: OriginCheckInput): boolean {
  if (!STATE_CHANGING_METHODS.has(input.method.toUpperCase())) return true
  if (!input.path.startsWith('/api/')) return true
  if (EXEMPT_PATHS.some(re => re.test(input.path))) return true

  if (input.origin !== undefined) {
    const host = hostOf(input.origin)
    return host !== null && allowedHosts(input).has(host)
  }
  if (input.secFetchSite !== undefined) {
    const site = input.secFetchSite.trim().toLowerCase()
    return site === 'same-origin' || site === 'none'
  }
  if (input.referer !== undefined) {
    const host = hostOf(input.referer)
    return host !== null && allowedHosts(input).has(host)
  }
  return true
}
