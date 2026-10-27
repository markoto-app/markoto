import { describe, expect, it } from 'vitest'
import { rateLimitIpKey } from '../../shared/utils/clientIp'

// Rate-limit buckets keyed on the client address. A single IPv6
// subscriber / VPS normally controls a whole /64, so keying on the full
// address would hand one client 2^64 buckets (e.g. unlimited password
// guesses by rotating source addresses).

describe('rateLimitIpKey', () => {
  it('keeps IPv4 addresses as they are', () => {
    expect(rateLimitIpKey('203.0.113.9')).toBe('203.0.113.9')
  })

  it('collapses IPv6 addresses to their /64', () => {
    expect(rateLimitIpKey('2001:db8:85a3:1234:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:85a3:1234::/64')
    expect(rateLimitIpKey('2001:db8:85a3:1234::1')).toBe('2001:db8:85a3:1234::/64')
  })

  it('puts every address of one /64 in the same bucket', () => {
    const a = rateLimitIpKey('2001:db8:1:2:0:0:0:1')
    const b = rateLimitIpKey('2001:db8:1:2:ffff:ffff:ffff:fffe')
    expect(a).toBe(b)
    expect(rateLimitIpKey('2001:db8:1:3::1')).not.toBe(a)
  })

  it('normalises case, leading zeros, compression and zone ids', () => {
    expect(rateLimitIpKey('2001:0DB8:0000:0001::5')).toBe('2001:db8:0:1::/64')
    expect(rateLimitIpKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(rateLimitIpKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
    expect(rateLimitIpKey('[2001:db8:1:2::9]')).toBe('2001:db8:1:2::/64')
  })

  it('treats IPv4-mapped IPv6 as the embedded IPv4 address', () => {
    expect(rateLimitIpKey('::ffff:203.0.113.9')).toBe('203.0.113.9')
    expect(rateLimitIpKey('0:0:0:0:0:ffff:203.0.113.9')).toBe('203.0.113.9')
  })

  it('falls back to one shared bucket for missing / unparseable input', () => {
    expect(rateLimitIpKey(null)).toBe('unknown')
    expect(rateLimitIpKey('')).toBe('unknown')
    expect(rateLimitIpKey('not-an-ip')).toBe('unknown')
    expect(rateLimitIpKey('1:2:3:4:5:6:7:8:9')).toBe('unknown')
    expect(rateLimitIpKey('2001:db8::1::2')).toBe('unknown')
  })
})
