// Client-IP resolution behind a known number of trusted reverse proxies.
//
// Used by the Nuxt app (`server/utils/platform/clientIp.ts`) and the sync server
// (`sync-server/src/rate-limiter.ts`) — rate limits and the truncated IP
// stored on audit / consent / abuse rows both key on it.
//
// Why "hops from the right" and not "first entry": every proxy APPENDS
// the address it received the connection from to `X-Forwarded-For`, so
// only the entries written by proxies we run are trustworthy. Anything
// to their left was supplied by the client and is spoofable — reading
// `split(',')[0]` lets any caller pick their own rate-limit bucket and
// audit IP by sending `X-Forwarded-For: 1.2.3.4`. With N trusted hops in
// front of the process, the N-th entry from the right is the address the
// outermost trusted proxy saw: the real client.
//
// Deployment shapes (see docs/SELF-HOSTING.md#trusted-proxy):
//   - Our Traefik in front (prod, self-host compose): 1 hop. Traefik also
//     strips client-sent X-Forwarded-* from untrusted peers, so the list
//     is normally a single entry — but the rule must not depend on that.
//   - Your own TLS proxy -> our Traefik -> app: 2 hops (and Traefik must
//     trust that proxy: TRAEFIK_TRUSTED_IPS in the self-host compose).
//   - App port exposed directly, no proxy: 0 hops — the socket address is
//     the only trustworthy value and X-Forwarded-For is ignored.

/** Default: one trusted hop — the Traefik in every shipped compose file. */
export const DEFAULT_TRUSTED_PROXY_HOPS = 1

/**
 * Parse the trusted-hop count (`NUXT_TRUSTED_PROXY_HOPS` in the app,
 * `TRUSTED_PROXY_HOPS` in the sync server). Empty / absent / malformed
 * values fall back to the default rather than to 0: 0 would key every
 * proxied request on the proxy's own address (one shared bucket), which
 * is a worse failure than the default for the shipped topology.
 */
export function parseTrustedProxyHops(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw.trim() === '') return DEFAULT_TRUSTED_PROXY_HOPS
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return DEFAULT_TRUSTED_PROXY_HOPS
  return Number(trimmed)
}

export interface ClientIpInput {
  /** Raw `X-Forwarded-For` header value(s), as the HTTP stack hands them over. */
  forwardedFor: string | string[] | undefined | null
  /** Address of the TCP peer (the nearest proxy, or the client itself). */
  remoteAddress: string | undefined | null
  /** Number of trusted reverse proxies in front of this process. */
  trustedHops: number
}

/** IPv6 zone ids (`fe80::1%eth0`) and surrounding brackets are not part of the address. */
function normaliseAddress(raw: string): string {
  let addr = raw.trim()
  if (addr.startsWith('[') && addr.includes(']')) addr = addr.slice(1, addr.indexOf(']'))
  const zone = addr.indexOf('%')
  if (zone >= 0) addr = addr.slice(0, zone)
  return addr
}

/**
 * Resolve the client address, or `null` when nothing usable is known.
 *
 * - `trustedHops <= 0` → the socket peer address; the header is ignored.
 * - Header present → the `trustedHops`-th entry from the right. When the
 *   list is SHORTER than the hop count, every entry was still written by
 *   a trusted proxy (a client reaching an inner proxy directly produces
 *   a one-entry list), so the leftmost entry is the best available value.
 * - Header absent → the socket peer address (direct connection).
 */
export function resolveClientIp(input: ClientIpInput): string | null {
  const remote = input.remoteAddress ? normaliseAddress(input.remoteAddress) : ''
  if (input.trustedHops <= 0) return remote || null

  const raw = Array.isArray(input.forwardedFor) ? input.forwardedFor.join(',') : (input.forwardedFor ?? '')
  const entries = raw.split(',').map(normaliseAddress).filter(e => e.length > 0)
  if (entries.length === 0) return remote || null

  const index = Math.max(0, entries.length - input.trustedHops)
  return entries[index] ?? null
}

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * Rate-limit bucket for a client address.
 *
 * IPv4: the address itself. IPv6: the /64 prefix — a single subscriber
 * or VPS is normally handed a whole /64, so keying on the full address
 * would give one client an unlimited number of buckets by rotating
 * source addresses. IPv4-mapped IPv6 (`::ffff:192.0.2.1`) counts as the
 * embedded IPv4 address. Unknown / unparseable → `'unknown'` (one shared
 * bucket, the conservative choice).
 *
 * Only for rate-limit KEYS. Audit / consent / abuse rows store the
 * GDPR-truncated form (`truncateIp` in server/repos/audit.ts) instead.
 */
export function rateLimitIpKey(ip: string | null | undefined): string {
  if (!ip) return 'unknown'
  const addr = normaliseAddress(ip).toLowerCase()
  if (IPV4_RE.test(addr)) return addr
  if (!addr.includes(':')) return 'unknown'

  const hextets = expandIpv6(addr)
  if (!hextets) return 'unknown'
  if (hextets.mappedIpv4) return hextets.mappedIpv4
  const prefix = hextets.parts.slice(0, 4).map(h => h.replace(/^0+(?=.)/, ''))
  return `${prefix.join(':')}::/64`
}

/**
 * Expand `::` into eight explicit hextets. A trailing dotted IPv4 part is
 * accepted only in the IPv4-mapped form (`::ffff:a.b.c.d`) and reported
 * separately. Null when the address isn't parseable IPv6.
 */
function expandIpv6(addr: string): { parts: string[], mappedIpv4: string | null } | null {
  let body = addr
  let embedded: string | null = null
  const lastColon = addr.lastIndexOf(':')
  const tail = addr.slice(lastColon + 1)
  if (tail.includes('.')) {
    if (!IPV4_RE.test(tail)) return null
    embedded = tail
    body = `${addr.slice(0, lastColon + 1)}0:0`
  }
  const halves = body.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0
  if (fill < 0) return null
  const parts = [...left, ...new Array<string>(fill).fill('0'), ...right]
  if (parts.length !== 8 || parts.some(p => !/^[0-9a-f]{1,4}$/.test(p))) return null
  if (embedded === null) return { parts, mappedIpv4: null }
  const isMapped = parts.slice(0, 5).every(p => /^0+$/.test(p)) && parts[5] === 'ffff'
  return isMapped ? { parts, mappedIpv4: embedded } : null
}
