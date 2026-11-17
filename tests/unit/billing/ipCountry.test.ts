import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { buildCountryIndex, GEOIP_DB_PATH, lookupCountry, parseIpv4, parseIpv6 } from '../../../server/utils/billing/ipCountry'

const FIXTURE = [
  '0.0.0.0,ZZ',
  '1.0.0.0,AU',
  '1.0.1.0,CN',
  '81.2.69.0,GB',
  '81.2.70.0,DE',
  '::,ZZ',
  '2001:db8::,CH',
  '2001:db8:0:1::,FR',
  '2001:db9::,ZZ'
].join('\n')

describe('IP address parsing', () => {
  it('parses IPv4 and refuses junk', () => {
    expect(parseIpv4('1.2.3.4')).toBe(0x01020304)
    expect(parseIpv4('255.255.255.255')).toBe(0xFFFFFFFF)
    expect(parseIpv4('1.2.3')).toBeNull()
    expect(parseIpv4('1.2.3.256')).toBeNull()
    expect(parseIpv4('a.b.c.d')).toBeNull()
  })

  it('parses IPv6 forms', () => {
    expect(parseIpv6('::')).toEqual([0n, 0n])
    expect(parseIpv6('2001:db8::1')).toEqual([0x20010db800000000n, 1n])
    expect(parseIpv6('::ffff:1.2.3.4')).toEqual([0n, 0xFFFF01020304n])
    expect(parseIpv6('fe80::1%eth0')).toEqual([0xfe80000000000000n, 1n])
    expect(parseIpv6('1:2:3:4:5:6:7:8:9')).toBeNull()
    expect(parseIpv6('1::2::3')).toBeNull()
    expect(parseIpv6('zz::1')).toBeNull()
  })
})

describe('lookupCountry', () => {
  const index = buildCountryIndex(FIXTURE)

  it('finds the range an address falls into', () => {
    expect(lookupCountry(index, '1.0.0.7')).toBe('AU')
    expect(lookupCountry(index, '1.0.255.255')).toBe('CN')
    expect(lookupCountry(index, '81.2.69.142')).toBe('GB')
    expect(lookupCountry(index, '81.2.70.1')).toBe('DE')
    expect(lookupCountry(index, '2001:db8::42')).toBe('CH')
    expect(lookupCountry(index, '2001:db8:0:1:ffff::1')).toBe('FR')
  })

  it('reads IPv4-mapped IPv6 addresses as IPv4', () => {
    expect(lookupCountry(index, '::ffff:81.2.69.1')).toBe('GB')
  })

  it('answers null for unknown, reserved and invalid input', () => {
    expect(lookupCountry(index, '0.1.2.3')).toBeNull()
    expect(lookupCountry(index, '2001:db9::1')).toBeNull()
    expect(lookupCountry(index, 'not-an-ip')).toBeNull()
    expect(lookupCountry(index, null)).toBeNull()
  })
})

describe('the bundled database', () => {
  const file = readFileSync(join(process.cwd(), GEOIP_DB_PATH))
  const source = JSON.parse(readFileSync(join(process.cwd(), 'geoip', 'source.json'), 'utf8')) as { fileSha256: string }

  it('is the file scripts/update-geoip.ts wrote (checksum in source.json)', () => {
    expect(createHash('sha256').update(file).digest('hex')).toBe(source.fileSha256)
  })

  it('resolves well-known addresses', () => {
    const index = buildCountryIndex(gunzipSync(file).toString('utf8'))
    expect(lookupCountry(index, '127.0.0.1')).toBeNull()
    expect(lookupCountry(index, '10.1.2.3')).toBeNull()
    expect(lookupCountry(index, '8.8.8.8')).toBe('US')
    expect(lookupCountry(index, '2a02:168::1')).toBe('CH')
  })
})
