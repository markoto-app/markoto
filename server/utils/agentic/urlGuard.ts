// Guards against SSRF in AI tool inputs. All URL-taking tools must call
// `assertSafeUrl()` before passing the URL onward. The model is allowed
// to ask for any HTTP(S) URL on the public internet; private CIDRs,
// metadata IPs, link-local, loopback, and non-HTTP schemes are all
// rejected with a clear error the agentic loop surfaces back to the
// model (so it learns and can pick a different URL).
//
// The guard catches:
//   - Cloud metadata endpoints (169.254.169.254, fd00:ec2::254) — would
//     otherwise let an attacker exfiltrate IAM credentials on AWS/GCP.
//   - In-cluster service banners (Postgres, Valkey, Hocuspocus, the
//     Nuxt app's own internal endpoints) reachable only via the
//     compose / k8s service network.
//   - `file://`, `gopher://`, `dict://`, `ftp://` — schemes the
//     downstream URL fetcher (Jina Reader, or a future provider) might
//     dereference depending on backend.
//   - DNS-resolved hostnames that map to private space — the public-DNS
//     answer is fine but the resolved IP is not (DNS rebinding-shaped).
//
// We can't fully prevent rebinding without piping the resolved IP into
// the actual fetch (Jina Reader re-resolves server-side, just as the
// pre-Phase-5 Gemini `urlContext` did). For our threat model — the AI
// is the requester, not a userland fetch pinned to one IP — single-
// resolve before forwarding the URL is the practical mitigation. A
// determined attacker with a controlled DNS authority that returns
// 1s-TTL records flipping public→private mid-resolution is out of
// scope here; the secondary defenses are the downstream rate limits +
// interaction caps + audit log.

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const ALLOWED_SCHEMES = new Set(['http:', 'https:'])

/**
 * IPv4 private + special-use ranges. Returns true if `ip` is an IPv4
 * dotted-quad in any of:
 *   - 0.0.0.0/8        — "this network"
 *   - 10.0.0.0/8       — RFC 1918
 *   - 100.64.0.0/10    — CGNAT (often used internally)
 *   - 127.0.0.0/8      — loopback
 *   - 169.254.0.0/16   — link-local + AWS/GCP metadata
 *   - 172.16.0.0/12    — RFC 1918
 *   - 192.0.0.0/24     — IETF protocol assignments
 *   - 192.168.0.0/16   — RFC 1918
 *   - 198.18.0.0/15    — benchmarking
 *   - 224.0.0.0/4      — multicast
 *   - 240.0.0.0/4      — reserved (incl. broadcast 255.255.255.255)
 */
/** Predicate matching `(a, b)` against one private/special-use IPv4 range. */
type Ipv4RangeCheck = (a: number, b: number) => boolean

/**
 * Table of private + special-use IPv4 ranges. Order is irrelevant; we
 * short-circuit on the first match. Comment carries the range name so
 * the table reads as documentation.
 */
const PRIVATE_IPV4_RANGES: Ipv4RangeCheck[] = [
  a => a === 0, //                        0.0.0.0/8        "this network"
  a => a === 10, //                       10.0.0.0/8       RFC 1918
  a => a === 127, //                      127.0.0.0/8      loopback
  (a, b) => a === 169 && b === 254, //    169.254.0.0/16   link-local + AWS/GCP metadata
  (a, b) => a === 172 && b >= 16 && b <= 31, // 172.16.0.0/12  RFC 1918
  (a, b) => a === 192 && b === 0, //      192.0.0.0/24     IETF protocol assignments
  (a, b) => a === 192 && b === 168, //    192.168.0.0/16   RFC 1918
  (a, b) => a === 198 && (b === 18 || b === 19), // 198.18.0.0/15  benchmarking
  (a, b) => a === 100 && b >= 64 && b <= 127, //   100.64.0.0/10  CGNAT
  a => a >= 224 //                        224.0.0.0/4 multicast + 240.0.0.0/4 reserved
]

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) {
    // Not a well-formed dotted-quad — refuse to classify as public.
    // Callers treat unclassifiable as private (fail-closed).
    return true
  }
  const [a, b] = parts as [number, number, number, number]
  return PRIVATE_IPV4_RANGES.some(check => check(a, b))
}

/**
 * Normalise an IPv6 address to its lowercase fully-expanded form. The
 * `node:net` parsers can't handle IPv6 numerically, but for prefix
 * checks we just need lowercase + the leading hextets.
 */
function ipv6FirstHextet(ip: string): number {
  const lower = ip.toLowerCase()
  // Strip a zone id ("fe80::1%eth0") if present.
  const noZone = lower.split('%')[0]!
  // "::1" expands to "0000:0000:...:0001"; we only need the FIRST
  // hextet for prefix tests, so just split on ':' and take the first
  // segment. "::1" → ["", "", "1"] → first non-empty hextet is "" so
  // treat that case explicitly.
  if (noZone === '::1') return 0 // loopback caught separately
  const segs = noZone.split(':')
  const first = segs[0]
  if (first === undefined || first === '') return 0
  const n = Number.parseInt(first, 16)
  return Number.isFinite(n) ? n : -1
}

/**
 * IPv6 private + special-use ranges. Returns true if `ip` is an IPv6
 * literal in any of:
 *   - ::1/128            — loopback
 *   - ::/128             — unspecified
 *   - fc00::/7           — Unique Local Addresses (RFC 4193)
 *   - fe80::/10          — link-local
 *   - ff00::/8           — multicast
 *   - ::ffff:0:0/96      — IPv4-mapped (re-check the embedded v4)
 */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().split('%')[0]!
  if (lower === '::1' || lower === '::') return true
  // IPv4-mapped IPv6 ("::ffff:127.0.0.1") — strip prefix, re-check v4.
  const mapped = /^::ffff:([0-9.]+)$/.exec(lower)
  if (mapped) {
    const v4 = mapped[1]!
    if (isIP(v4) === 4) return isPrivateIPv4(v4)
    return true // malformed — fail closed
  }
  const first = ipv6FirstHextet(lower)
  if (first < 0) return true // unparseable — fail closed
  // fc00::/7  → first hextet 0xfc00..0xfdff
  if (first >= 0xfc00 && first <= 0xfdff) return true
  // fe80::/10 → first hextet 0xfe80..0xfebf
  if (first >= 0xfe80 && first <= 0xfebf) return true
  // ff00::/8 multicast
  if (first >= 0xff00 && first <= 0xffff) return true
  return false
}

/**
 * Classifier: is `ip` a private/internal IP we must refuse?
 * Dispatches by family detected via `node:net.isIP`.
 */
export function isPrivateIp(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return isPrivateIPv4(ip)
  if (family === 6) return isPrivateIPv6(ip)
  // Not a recognisable IP at all — refuse classification.
  return true
}

/**
 * Narrower classifier for addresses that are NEVER a legitimate target,
 * even when an operator explicitly allows private networks (the BYOK
 * `NUXT_AI_BYOK_ALLOW_PRIVATE_URLS` opt-in for Ollama / vLLM on the
 * LAN): loopback (the caller's own container), "this network",
 * link-local incl. the cloud metadata endpoint `169.254.169.254`,
 * multicast + reserved space, and their IPv6 equivalents. Unparseable
 * input is treated as forbidden (fail closed).
 *
 * RFC 1918 / CGNAT / IPv6 ULA ranges are deliberately NOT in this set —
 * they are "private but reachable on purpose" (a docker bridge, a LAN
 * GPU box) and are governed by the opt-in instead.
 */
export function isAlwaysForbiddenIp(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) {
    const parts = ip.split('.').map(Number)
    if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return true
    const [a, b] = parts as [number, number, number, number]
    return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224
  }
  if (family === 6) {
    const lower = ip.toLowerCase().split('%')[0]!
    if (lower === '::1' || lower === '::') return true
    const mapped = /^::ffff:([0-9.]+)$/.exec(lower)
    if (mapped) return isIP(mapped[1]!) === 4 ? isAlwaysForbiddenIp(mapped[1]!) : true
    // AWS IMDS over IPv6.
    if (lower === 'fd00:ec2::254') return true
    const first = ipv6FirstHextet(lower)
    if (first < 0) return true
    if (first >= 0xfe80 && first <= 0xfebf) return true // link-local
    if (first >= 0xff00) return true // multicast
    return false
  }
  return true
}

/**
 * Resolves a hostname to all A/AAAA records and rejects if ANY resolved
 * IP is private. Catches DNS-rebinding-shaped attacks where the public
 * authoritative answer is fine but a TOCTOU resolves to a private IP.
 *
 * Throws a descriptive `Error` so the agentic loop surfaces the message
 * back to the model and the model can self-correct with a different URL.
 */
export async function assertSafeUrl(rawUrl: string): Promise<void> {
  const parsed = parseUrlOrThrow(rawUrl)
  assertAllowedScheme(parsed)
  const host = extractHostname(parsed)
  if (isIP(host) !== 0) {
    assertPublicLiteral(host)
    return
  }
  await assertPublicResolution(host)
}

/**
 * Trim, prepend `https://` to bare hostnames (mirrors the scheme-prepend
 * in `fetchUrl` so we don't reject benign inputs), and parse. Throws a
 * descriptive Error so the agentic loop can surface it back to the
 * model and the model can self-correct with a different URL.
 */
function parseUrlOrThrow(rawUrl: string): URL {
  const trimmed = (rawUrl ?? '').trim()
  if (!trimmed) throw new Error('URL refused: empty URL.')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(withScheme)
  } catch {
    throw new Error(`URL refused: malformed URL "${trimmed.slice(0, 80)}".`)
  }
}

function assertAllowedScheme(parsed: URL): void {
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(`URL refused: scheme "${parsed.protocol}" not allowed. Use http:// or https://.`)
  }
}

/**
 * `URL.hostname` keeps brackets around IPv6 literals
 * (`http://[::1]/` → `[::1]`). Strip them for IP classification, and
 * fail loudly on the (rare but possible) empty-hostname case.
 */
function extractHostname(parsed: URL): string {
  const host = parsed.hostname
  if (!host) throw new Error('URL refused: missing hostname.')
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function assertPublicLiteral(host: string): void {
  if (isPrivateIp(host)) {
    throw new Error('URL refused: hostname resolves to a private IP. Use a public URL.')
  }
}

/**
 * DNS resolution. `lookup({ all: true })` returns every A + AAAA. ANY
 * private resolved IP fails — covers rebinding-shaped setups where
 * one record is public and another private.
 */
async function assertPublicResolution(host: string): Promise<void> {
  let addresses: Array<{ address: string, family: number }>
  try {
    addresses = await lookup(host, { all: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'DNS lookup failed'
    throw new Error(`URL refused: hostname "${host}" could not be resolved (${msg}).`, { cause: e })
  }
  if (!addresses.length) {
    throw new Error(`URL refused: hostname "${host}" returned no DNS records.`)
  }
  for (const a of addresses) {
    if (isPrivateIp(a.address)) {
      throw new Error('URL refused: hostname resolves to a private IP. Use a public URL.')
    }
  }
}
