import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEvent } from 'h3'
import {
  DEFAULT_TRUSTED_PROXY_HOPS,
  parseTrustedProxyHops,
  resolveClientIp
} from '../../shared/utils/clientIp'
import { getClientIp } from '../../server/utils/clientIp'

// Client-IP resolution: rate-limit keys + the truncated IP on audit /
// consent / abuse rows. The security property under test is that a
// client-supplied X-Forwarded-For prefix can never choose the result.

describe('parseTrustedProxyHops', () => {
  it('defaults to one hop (the shipped Traefik) when unset or empty', () => {
    expect(parseTrustedProxyHops(undefined)).toBe(DEFAULT_TRUSTED_PROXY_HOPS)
    expect(parseTrustedProxyHops(null)).toBe(1)
    expect(parseTrustedProxyHops('')).toBe(1)
    expect(parseTrustedProxyHops('   ')).toBe(1)
  })

  it('accepts non-negative integers, including 0 (no proxy)', () => {
    expect(parseTrustedProxyHops('0')).toBe(0)
    expect(parseTrustedProxyHops(' 2 ')).toBe(2)
  })

  it('falls back to the default on malformed values instead of trusting nothing / everything', () => {
    expect(parseTrustedProxyHops('-1')).toBe(1)
    expect(parseTrustedProxyHops('1.5')).toBe(1)
    expect(parseTrustedProxyHops('two')).toBe(1)
  })
})

describe('resolveClientIp', () => {
  it('one trusted hop: the rightmost entry wins over a spoofed prefix', () => {
    expect(resolveClientIp({
      forwardedFor: '6.6.6.6, 203.0.113.9',
      remoteAddress: '172.18.0.2',
      trustedHops: 1
    })).toBe('203.0.113.9')
  })

  it('one trusted hop with a single entry (Traefik stripped the client header)', () => {
    expect(resolveClientIp({ forwardedFor: '203.0.113.9', remoteAddress: '172.18.0.2', trustedHops: 1 }))
      .toBe('203.0.113.9')
  })

  it('two trusted hops: skips the inner proxy, still ignores the client prefix', () => {
    expect(resolveClientIp({
      forwardedFor: '6.6.6.6, 203.0.113.9, 10.0.0.2',
      remoteAddress: '172.18.0.2',
      trustedHops: 2
    })).toBe('203.0.113.9')
  })

  it('fewer entries than hops: the leftmost (still proxy-written) entry', () => {
    expect(resolveClientIp({ forwardedFor: '203.0.113.9', remoteAddress: null, trustedHops: 3 }))
      .toBe('203.0.113.9')
  })

  it('zero hops ignores the header entirely and uses the socket peer', () => {
    expect(resolveClientIp({ forwardedFor: '6.6.6.6', remoteAddress: '198.51.100.4', trustedHops: 0 }))
      .toBe('198.51.100.4')
    expect(resolveClientIp({ forwardedFor: '6.6.6.6', remoteAddress: undefined, trustedHops: 0 }))
      .toBeNull()
  })

  it('no header: the socket peer (direct connection)', () => {
    expect(resolveClientIp({ forwardedFor: undefined, remoteAddress: '198.51.100.4', trustedHops: 1 }))
      .toBe('198.51.100.4')
    expect(resolveClientIp({ forwardedFor: ' , ', remoteAddress: '198.51.100.4', trustedHops: 1 }))
      .toBe('198.51.100.4')
  })

  it('nothing known → null', () => {
    expect(resolveClientIp({ forwardedFor: null, remoteAddress: null, trustedHops: 1 })).toBeNull()
  })

  it('joins array-valued headers (repeated header lines) before counting hops', () => {
    expect(resolveClientIp({
      forwardedFor: ['6.6.6.6', '203.0.113.9'],
      remoteAddress: null,
      trustedHops: 1
    })).toBe('203.0.113.9')
  })

  it('normalises whitespace, IPv6 brackets and zone ids', () => {
    expect(resolveClientIp({ forwardedFor: '  [2001:db8::1]  ', remoteAddress: null, trustedHops: 1 }))
      .toBe('2001:db8::1')
    expect(resolveClientIp({ forwardedFor: undefined, remoteAddress: 'fe80::1%eth0', trustedHops: 1 }))
      .toBe('fe80::1')
  })
})

describe('getClientIp (h3 event)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function eventWith(headers: Record<string, string>, remoteAddress: string) {
    const socket = new Socket()
    Object.defineProperty(socket, 'remoteAddress', { value: remoteAddress })
    const req = new IncomingMessage(socket)
    for (const [k, v] of Object.entries(headers)) req.headers[k] = v
    return createEvent(req, new ServerResponse(req))
  }

  it('default (unset env): one hop — rightmost XFF entry', () => {
    vi.stubEnv('NUXT_TRUSTED_PROXY_HOPS', '')
    const event = eventWith({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, '172.18.0.5')
    expect(getClientIp(event)).toBe('203.0.113.9')
  })

  it('ignores X-Real-IP (client-settable when not behind Traefik)', () => {
    vi.stubEnv('NUXT_TRUSTED_PROXY_HOPS', '1')
    const event = eventWith({ 'x-real-ip': '6.6.6.6' }, '198.51.100.4')
    expect(getClientIp(event)).toBe('198.51.100.4')
  })

  it('NUXT_TRUSTED_PROXY_HOPS=0 uses the socket address', () => {
    vi.stubEnv('NUXT_TRUSTED_PROXY_HOPS', '0')
    const event = eventWith({ 'x-forwarded-for': '6.6.6.6' }, '198.51.100.4')
    expect(getClientIp(event)).toBe('198.51.100.4')
  })

  it('NUXT_TRUSTED_PROXY_HOPS=2 skips one inner proxy', () => {
    vi.stubEnv('NUXT_TRUSTED_PROXY_HOPS', '2')
    const event = eventWith({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2' }, '172.18.0.5')
    expect(getClientIp(event)).toBe('203.0.113.9')
  })
})
