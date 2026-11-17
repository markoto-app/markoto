#!/usr/bin/env bun
// Refresh the bundled IP-to-country database (geoip/).
//
//   bun scripts/update-geoip.ts [YYYY-MM] [--sha256 <hex>]
//
// Downloads DB-IP's free "IP to Country Lite" CSV for the month (default:
// the current one), checks it, and writes the compact copy the app reads
// (`geoip/dbip-country-lite.csv.gz`: one `range start,country` line per
// range; the end of a range is the next start, DB-IP's ranges are
// contiguous) plus `geoip/source.json`. DB-IP keeps only the latest one or
// two months online, so the derived file is committed instead of being
// downloaded at image build. Pass `--sha256` with the checksum of the
// download you verified to pin it. Licence: CC BY 4.0, attribution in NOTICE
// and geoip/LICENSE.txt.

import { gunzipSync, gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const shaIndex = args.indexOf('--sha256')
const expectedSha = shaIndex >= 0 ? args[shaIndex + 1] : undefined
const month = args.find(a => /^\d{4}-\d{2}$/.test(a)) ?? new Date().toISOString().slice(0, 7)
const url = `https://download.db-ip.com/free/dbip-country-lite-${month}.csv.gz`

const res = await fetch(url)
if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`)
const gz = Buffer.from(await res.arrayBuffer())
const sha256 = createHash('sha256').update(gz).digest('hex')
if (expectedSha && expectedSha !== sha256) throw new Error(`checksum mismatch: expected ${expectedSha}, got ${sha256}`)

const lines = gunzipSync(gz).toString('utf8').split('\n').filter(Boolean)
const out: string[] = []
let v4 = 0
let v6 = 0
for (const line of lines) {
  const [start, , country] = line.split(',')
  if (!start || !country || !/^[A-Z]{2}$/.test(country)) throw new Error(`unexpected line: ${line}`)
  if (start.includes(':')) v6++
  else v4++
  out.push(`${start},${country}`)
}
if (v4 < 100_000 || v6 < 100_000) throw new Error(`implausibly small database: ${v4} IPv4 / ${v6} IPv6 ranges`)

const dir = join(import.meta.dir, '..', 'geoip')
const compact = gzipSync(out.join('\n') + '\n', { level: 9 })
writeFileSync(join(dir, 'dbip-country-lite.csv.gz'), compact)
writeFileSync(join(dir, 'source.json'), JSON.stringify({
  source: url,
  month,
  sha256,
  // Of the derived file; tests/unit/billing/ipCountry.test.ts checks it.
  fileSha256: createHash('sha256').update(compact).digest('hex'),
  ipv4Ranges: v4,
  ipv6Ranges: v6,
  licence: 'CC BY 4.0, IP Geolocation by DB-IP (https://db-ip.com)'
}, null, 2) + '\n')
console.log(`geoip: ${month}, ${v4} IPv4 + ${v6} IPv6 ranges, sha256 ${sha256}`)
