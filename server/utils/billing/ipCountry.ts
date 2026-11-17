import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { useLogger } from '../platform/logger'

const log = useLogger('ip-country')

// The country of an IP address, from the bundled offline database
// (`geoip/dbip-country-lite.csv.gz`, DB-IP Lite, CC BY 4.0; refreshed with
// `scripts/update-geoip.ts`). No third-party call per request: the address
// never leaves the process and only the derived country code is stored, as
// the second piece of location evidence for a sale (EU VAT, Art. 24b
// Implementing Regulation 282/2011). Loaded on first use (a few hundred ms,
// about 15 MB); a missing file means "unknown", never an error.

/** The file's lines: `range start,country`, ascending, IPv4 first; a range ends where the next starts. */
export interface CountryIndex {
  codes: string[]
  v4Starts: Uint32Array
  v4Country: Uint16Array
  v6Hi: BigUint64Array
  v6Lo: BigUint64Array
  v6Country: Uint16Array
}

const UNKNOWN = 'ZZ'

export function parseIpv4(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const octet = Number(p)
    if (octet > 255) return null
    n = n * 256 + octet
  }
  return n
}

/** An IPv6 address as two 64-bit halves; an embedded dotted IPv4 tail is accepted. */
export function parseIpv6(ip: string): [bigint, bigint] | null {
  let text = ip.trim().toLowerCase()
  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)
  if (tail?.[1]) {
    const v4 = parseIpv4(tail[1])
    if (v4 === null) return null
    text = `${text.slice(0, -tail[1].length)}${(v4 >>> 16).toString(16)}:${(v4 & 0xFFFF).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest]
  let hi = 0n
  let lo = 0n
  for (let i = 0; i < 8; i++) {
    const g = groups[i] ?? ''
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    const value = BigInt(Number.parseInt(g, 16))
    if (i < 4) hi = (hi << 16n) | value
    else lo = (lo << 16n) | value
  }
  return [hi, lo]
}

/** IPv4-mapped (`::ffff:a.b.c.d`) addresses are IPv4 addresses. */
function mappedIpv4(hi: bigint, lo: bigint): number | null {
  if (hi !== 0n || lo >> 32n !== 0xFFFFn) return null
  return Number(lo & 0xFFFFFFFFn)
}

export function buildCountryIndex(text: string): CountryIndex {
  const codes: string[] = []
  const codeIds = new Map<string, number>()
  const v4: [number, number][] = []
  const v6: [bigint, bigint, number][] = []
  const codeId = (code: string): number => {
    let id = codeIds.get(code)
    if (id === undefined) {
      id = codes.length
      codes.push(code)
      codeIds.set(code, id)
    }
    return id
  }
  for (const line of text.split('\n')) {
    const comma = line.indexOf(',')
    if (comma < 0) continue
    const start = line.slice(0, comma)
    const id = codeId(line.slice(comma + 1).trim())
    if (start.includes(':')) {
      const parsed = parseIpv6(start)
      if (parsed) v6.push([parsed[0], parsed[1], id])
    } else {
      const parsed = parseIpv4(start)
      if (parsed !== null) v4.push([parsed, id])
    }
  }
  v4.sort((a, b) => a[0] - b[0])
  v6.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
  return {
    codes,
    v4Starts: Uint32Array.from(v4.map(r => r[0])),
    v4Country: Uint16Array.from(v4.map(r => r[1])),
    v6Hi: BigUint64Array.from(v6.map(r => r[0])),
    v6Lo: BigUint64Array.from(v6.map(r => r[1])),
    v6Country: Uint16Array.from(v6.map(r => r[2]))
  }
}

/** Index of the last start <= the address, or -1. */
function lastAtOrBelow(count: number, below: (i: number) => boolean): number {
  let lo = 0
  let hi = count - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (below(mid)) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/** ISO 3166-1 alpha-2 country of `ip`, or null (unknown, reserved, unparsable). */
export function lookupCountry(index: CountryIndex, ip: string | null | undefined): string | null {
  if (!ip) return null
  let v4 = ip.includes(':') ? null : parseIpv4(ip)
  let code: string | undefined
  if (v4 === null) {
    const v6 = ip.includes(':') ? parseIpv6(ip) : null
    if (!v6) return null
    v4 = mappedIpv4(v6[0], v6[1])
    if (v4 === null) {
      const [hi, lo] = v6
      const i = lastAtOrBelow(index.v6Hi.length, m => {
        const h = index.v6Hi[m] ?? 0n
        return h < hi || (h === hi && (index.v6Lo[m] ?? 0n) <= lo)
      })
      code = i >= 0 ? index.codes[index.v6Country[i] ?? 0] : undefined
    }
  }
  if (v4 !== null) {
    const addr = v4
    const i = lastAtOrBelow(index.v4Starts.length, m => (index.v4Starts[m] ?? 0) <= addr)
    code = i >= 0 ? index.codes[index.v4Country[i] ?? 0] : undefined
  }
  return code && code !== UNKNOWN && /^[A-Z]{2}$/.test(code) ? code : null
}

/** Where the image and the dev checkout keep the database. */
export const GEOIP_DB_PATH = join('geoip', 'dbip-country-lite.csv.gz')

let loading: Promise<CountryIndex | null> | null = null

async function loadIndex(): Promise<CountryIndex | null> {
  try {
    const gz = await readFile(join(process.cwd(), GEOIP_DB_PATH))
    return buildCountryIndex(gunzipSync(gz).toString('utf8'))
  } catch (e) {
    log.warn('IP country database not available, countries stay unknown', { err: e })
    return null
  }
}

/** The country of the client IP from the bundled database; null when unknown. */
export async function countryOfIp(ip: string | null | undefined): Promise<string | null> {
  if (!ip) return null
  loading ??= loadIndex()
  const index = await loading
  return index ? lookupCountry(index, ip) : null
}
