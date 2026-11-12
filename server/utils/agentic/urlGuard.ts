// Guards against SSRF in AI tool inputs. All URL-taking tools must call
// `assertSafeUrl()` (or `resolvePublicAddresses()` when they open the
// connection themselves) before passing the URL onward. The model is
// allowed to ask for any HTTP(S) URL on the public internet; private
// CIDRs, metadata IPs, link-local, loopback, and non-HTTP schemes are all
// rejected with a clear error the agentic loop surfaces back to the
// model (so it learns and can pick a different URL).
//
// The guard catches:
//   - Cloud metadata endpoints (169.254.169.254, fd00:ec2::254), would
//     otherwise let an attacker exfiltrate IAM credentials on AWS/GCP.
//   - In-cluster service banners (Postgres, Valkey, Hocuspocus, the
//     Nuxt app's own internal endpoints) reachable only via the
//     compose / k8s service network.
//   - `file://`, `gopher://`, `dict://`, `ftp://`, schemes the
//     downstream URL fetcher (Jina Reader, or a future provider) might
//     dereference depending on backend.
//   - DNS-resolved hostnames that map to private space, the public-DNS
//     answer is fine but the resolved IP is not (DNS rebinding-shaped).
//   - Every textual form of an IPv6 address that embeds an IPv4 one
//     (`::ffff:7f00:1`, NAT64, 6to4, …): addresses are parsed into bytes.
//
// Rebinding: `fetch_url` forwards the URL to Jina Reader, which resolves
// it again on its own network, nothing we can pin there. Where the app
// itself connects (`view_image`, `safeFetch.ts`), it connects to the
// address that was checked, so a DNS answer that flips after the check
// is never used.

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const ALLOWED_SCHEMES = new Set(['http:', 'https:'])

/** Longest URL the URL-taking tools accept (fetch_url, view_image). */
const MAX_TOOL_URL_LENGTH = 2000

/**
 * Address classes, from most to least restrictive:
 *   - `forbidden`: never a legitimate target, even when an operator
 *     allows private networks (BYOK `NUXT_AI_BYOK_ALLOW_PRIVATE_URLS`):
 *     loopback, "this network", link-local incl. cloud metadata,
 *     multicast, reserved, documentation/discard ranges, tunnelling
 *     prefixes whose real endpoint can't be verified, unparseable input.
 *   - `private`: reachable on purpose on a LAN / docker bridge
 *     (RFC 1918, CGNAT, IPv6 unique-local / site-local); refused unless
 *     the caller opts in.
 *   - `public`: anything else in global unicast space.
 *
 * Addresses are parsed into bytes (no regexes on the text form), so every
 * spelling of the same address, `::ffff:127.0.0.1`, `::ffff:7f00:1`,
 * `0:0:0:0:0:ffff:7f00:0001`: gets the same answer. IPv6 forms that
 * carry an IPv4 address (IPv4-mapped, IPv4-compatible, IPv4-translated,
 * NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) are classified by the embedded
 * IPv4 address.
 */
export type IpClass = 'public' | 'private' | 'forbidden'

type Bytes = readonly number[]

interface IpRange {
  /** Network prefix as bytes (rest zero). */
  net: Bytes
  bits: number
  cls: Exclude<IpClass, 'public'>
}

const IPV4_RANGES: readonly IpRange[] = [
  { net: [0, 0, 0, 0], bits: 8, cls: 'forbidden' }, //        "this network"
  { net: [127, 0, 0, 0], bits: 8, cls: 'forbidden' }, //      loopback
  { net: [169, 254, 0, 0], bits: 16, cls: 'forbidden' }, //   link-local + AWS/GCP metadata
  { net: [192, 0, 2, 0], bits: 24, cls: 'forbidden' }, //     TEST-NET-1 (documentation)
  { net: [198, 51, 100, 0], bits: 24, cls: 'forbidden' }, //  TEST-NET-2
  { net: [203, 0, 113, 0], bits: 24, cls: 'forbidden' }, //   TEST-NET-3
  { net: [224, 0, 0, 0], bits: 4, cls: 'forbidden' }, //      multicast
  { net: [240, 0, 0, 0], bits: 4, cls: 'forbidden' }, //      reserved incl. broadcast
  { net: [10, 0, 0, 0], bits: 8, cls: 'private' }, //         RFC 1918
  { net: [100, 64, 0, 0], bits: 10, cls: 'private' }, //      CGNAT
  { net: [172, 16, 0, 0], bits: 12, cls: 'private' }, //      RFC 1918
  { net: [192, 0, 0, 0], bits: 24, cls: 'private' }, //       IETF protocol assignments
  { net: [192, 88, 99, 0], bits: 24, cls: 'private' }, //     6to4 relay anycast (deprecated)
  { net: [192, 168, 0, 0], bits: 16, cls: 'private' }, //     RFC 1918
  { net: [198, 18, 0, 0], bits: 15, cls: 'private' } //       benchmarking
]

function hextetsToBytes(hextets: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < 8; i++) {
    const h = hextets[i] ?? 0
    out.push((h >> 8) & 0xff, h & 0xff)
  }
  return out
}

function v6Range(hextets: number[], bits: number, cls: IpRange['cls']): IpRange {
  return { net: hextetsToBytes(hextets), bits, cls }
}

const IPV6_RANGES: readonly IpRange[] = [
  v6Range([0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254], 128, 'forbidden'), // AWS IMDS over IPv6
  v6Range([0x0064, 0xff9b, 0x0001], 48, 'private'), //                    NAT64 local-use (RFC 8215)
  v6Range([0x0100], 64, 'forbidden'), //                                  discard-only
  v6Range([0x2001, 0x0db8], 32, 'forbidden'), //                          documentation
  // IETF special-purpose block, incl. Teredo 2001::/32 (its real
  // endpoint is obfuscated in the address and can't be checked).
  v6Range([0x2001], 23, 'forbidden'),
  v6Range([0xfc00], 7, 'private'), //                                     unique-local (RFC 4193)
  v6Range([0xfe80], 10, 'forbidden'), //                                  link-local
  v6Range([0xfec0], 10, 'private'), //                                    site-local (deprecated)
  v6Range([0xff00], 8, 'forbidden') //                                    multicast
]

const NAT64_WELL_KNOWN = hextetsToBytes([0x0064, 0xff9b])

function matchesPrefix(bytes: Bytes, prefix: Bytes, bits: number): boolean {
  for (let bit = 0; bit < bits; bit += 8) {
    const width = Math.min(8, bits - bit)
    const mask = (0xff << (8 - width)) & 0xff
    const index = bit / 8
    if (((bytes[index] ?? 0) & mask) !== ((prefix[index] ?? 0) & mask)) return false
  }
  return true
}

/** Strict dotted-quad parser (what `isIP` accepts as family 4). */
function parseIPv4(ip: string): number[] | null {
  if (isIP(ip) !== 4) return null
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return null
  return parts
}

function parseHextetGroups(part: string): number[] | null {
  if (part === '') return []
  const groups = part.split(':').map(g => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN))
  return groups.some(Number.isNaN) ? null : groups
}

/** Parse any valid IPv6 text form (zone id stripped) into 16 bytes. */
function parseIPv6(raw: string): number[] | null {
  const ip = raw.split('%')[0] ?? ''
  if (isIP(ip) !== 6) return null
  let text = ip.toLowerCase()
  // A trailing dotted IPv4 (`::ffff:1.2.3.4`) becomes two hextets.
  const lastColon = text.lastIndexOf(':')
  const tail = text.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail)
    if (!v4) return null
    const [a = 0, b = 0, c = 0, d = 0] = v4
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = parseHextetGroups(halves[0] ?? '')
  const rest = halves.length === 2 ? parseHextetGroups(halves[1] ?? '') : []
  if (!head || !rest) return null
  if (halves.length === 1 && head.length !== 8) return null
  if (halves.length === 2 && head.length + rest.length > 7) return null
  const zeros = new Array<number>(8 - head.length - rest.length).fill(0)
  return hextetsToBytes([...head, ...zeros, ...rest])
}

function classifyRanges(bytes: Bytes, ranges: readonly IpRange[]): IpClass | null {
  for (const range of ranges) {
    if (matchesPrefix(bytes, range.net, range.bits)) return range.cls
  }
  return null
}

function classifyIPv4Bytes(bytes: Bytes): IpClass {
  return classifyRanges(bytes, IPV4_RANGES) ?? 'public'
}

/** The IPv4 address an IPv6 address carries, if it is one of the embedding forms. */
function embeddedIPv4(bytes: Bytes): Bytes | null {
  const zeroUpTo = (n: number) => bytes.slice(0, n).every(b => b === 0)
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, deprecated)
  if (zeroUpTo(10) && bytes[10] === bytes[11] && (bytes[10] === 0xff || bytes[10] === 0)) {
    return bytes.slice(12, 16)
  }
  // ::ffff:0:a.b.c.d (IPv4-translated, RFC 2765)
  if (zeroUpTo(8) && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0) {
    return bytes.slice(12, 16)
  }
  // 64:ff9b::a.b.c.d (NAT64 well-known prefix, RFC 6052)
  if (matchesPrefix(bytes, NAT64_WELL_KNOWN, 96)) return bytes.slice(12, 16)
  // 2002:aabb:ccdd::/48 (6to4)
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return bytes.slice(2, 6)
  return null
}

function classifyIPv6Bytes(bytes: Bytes): IpClass {
  const allZeroBefore15 = bytes.slice(0, 15).every(b => b === 0)
  if (allZeroBefore15 && (bytes[15] === 0 || bytes[15] === 1)) return 'forbidden' // :: and ::1
  const v4 = embeddedIPv4(bytes)
  if (v4) return classifyIPv4Bytes(v4)
  const special = classifyRanges(bytes, IPV6_RANGES)
  if (special) return special
  // Only 2000::/3 is allocated global unicast; anything else is reserved.
  const first = bytes[0] ?? 0
  return first >= 0x20 && first <= 0x3f ? 'public' : 'forbidden'
}

/** Classify an IP address literal. Unparseable input is `forbidden`. */
export function classifyIp(ip: string): IpClass {
  const v4 = parseIPv4(ip)
  if (v4) return classifyIPv4Bytes(v4)
  const v6 = parseIPv6(ip)
  if (v6) return classifyIPv6Bytes(v6)
  return 'forbidden'
}

/** Is `ip` anything but a public address? (Fails closed on garbage.) */
export function isPrivateIp(ip: string): boolean {
  return classifyIp(ip) !== 'public'
}

/**
 * Narrower check: addresses that are NEVER a legitimate target, even when
 * an operator explicitly allows private networks (the BYOK opt-in for
 * Ollama / vLLM on the LAN). RFC 1918 / CGNAT / ULA / site-local are
 * deliberately not in this set, they are governed by the opt-in.
 */
export function isAlwaysForbiddenIp(ip: string): boolean {
  return classifyIp(ip) === 'forbidden'
}

/**
 * Check a host's addresses in order against an "outbound to a configured
 * server" policy (BYOK providers, SSO identity providers): the first
 * always-forbidden address refuses, a private one refuses unless
 * `allowPrivate`. Otherwise reports whether any address is public (plain
 * http is only for all-private targets).
 */
export function screenHostAddresses(addresses: readonly string[], allowPrivate: boolean): { refused: 'forbidden' } | { refused: 'private' } | { refused: null, anyPublic: boolean } {
  let anyPublic = false
  for (const address of addresses) {
    if (isAlwaysForbiddenIp(address)) return { refused: 'forbidden' }
    if (!isPrivateIp(address)) anyPublic = true
    else if (!allowPrivate) return { refused: 'private' }
  }
  return { refused: null, anyPublic }
}

/** A host's addresses: an IP literal is its own, a name goes through `resolve`. */
export async function hostAddresses(host: string, resolve: (host: string) => Promise<string[]>): Promise<string[] | 'unresolvable' | 'no-records'> {
  if (isIP(host) !== 0) return [host]
  let addresses: string[]
  try {
    addresses = await resolve(host)
  } catch {
    return 'unresolvable'
  }
  return addresses.length === 0 ? 'no-records' : addresses
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
  await resolvePublicAddresses(parseToolUrl(rawUrl))
}

/**
 * Parse a tool-supplied URL (scheme-less input gets `https://`) and run
 * the structural checks: length, http(s) scheme, hostname present. The
 * returned `URL#href` is what callers forward, never the raw string, so
 * the URL that was checked is the URL that is used.
 */
export function parseToolUrl(rawUrl: string): URL {
  const parsed = parseUrlOrThrow(rawUrl)
  assertAllowedScheme(parsed)
  extractHostname(parsed)
  return parsed
}

export type HostResolver = (host: string) => Promise<string[]>

export const systemHostResolver: HostResolver = async (host) => {
  const rows = await lookup(host, { all: true })
  return rows.map(r => r.address)
}

/**
 * Every address the URL's host stands for, each checked public. An IP
 * literal is classified directly; a name is resolved (all A + AAAA) and
 * refused if ANY answer is not public. Callers that open the connection
 * themselves must connect to one of the returned addresses (see
 * `safeFetch.ts`) so a DNS answer that changes after the check is never
 * used.
 */
export async function resolvePublicAddresses(parsed: URL, resolve: HostResolver = systemHostResolver): Promise<string[]> {
  const host = extractHostname(parsed)
  if (isIP(host) !== 0) {
    assertPublicLiteral(host)
    return [host]
  }
  return assertPublicResolution(host, resolve)
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
  if (trimmed.length > MAX_TOOL_URL_LENGTH) {
    throw new Error(`URL refused: longer than ${MAX_TOOL_URL_LENGTH} characters.`)
  }
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
 * DNS resolution. Every A + AAAA answer is checked; ANY private resolved
 * IP fails: covers rebinding-shaped setups where one record is public
 * and another private.
 */
async function assertPublicResolution(host: string, resolve: HostResolver): Promise<string[]> {
  let addresses: string[]
  try {
    addresses = await resolve(host)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'DNS lookup failed'
    throw new Error(`URL refused: hostname "${host}" could not be resolved (${msg}).`, { cause: e })
  }
  if (!addresses.length) {
    throw new Error(`URL refused: hostname "${host}" returned no DNS records.`)
  }
  for (const address of addresses) {
    if (isPrivateIp(address)) {
      throw new Error('URL refused: hostname resolves to a private IP. Use a public URL.')
    }
  }
  return addresses
}
