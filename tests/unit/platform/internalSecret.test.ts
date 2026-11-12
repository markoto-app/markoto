import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cameThroughEdgeProxy,
  checkInternalSecret,
  INTERNAL_SECRET_HEADER,
  matchesCurrentOrPrevious
} from '../../../shared/utils/security/internalSecret'

// The service-to-service secret check used by the app, the sync-server and
// the renderer. A false positive is a cross-service authz bypass.

describe('matchesCurrentOrPrevious', () => {
  it('accepts the current and, during a rotation, the previous secret', () => {
    expect(matchesCurrentOrPrevious('new-secret', 'new-secret', 'old-secret')).toBe(true)
    expect(matchesCurrentOrPrevious('old-secret', 'new-secret', 'old-secret')).toBe(true)
  })

  it('rejects anything else, including prefixes and extensions of a secret', () => {
    expect(matchesCurrentOrPrevious('other', 'new-secret', 'old-secret')).toBe(false)
    expect(matchesCurrentOrPrevious('new-secre', 'new-secret')).toBe(false)
    expect(matchesCurrentOrPrevious('new-secret-', 'new-secret')).toBe(false)
    expect(matchesCurrentOrPrevious('old-secret', 'new-secret', null)).toBe(false)
  })

  it('never matches an empty secret on either side', () => {
    expect(matchesCurrentOrPrevious('', '')).toBe(false)
    expect(matchesCurrentOrPrevious('', 'abc')).toBe(false)
    expect(matchesCurrentOrPrevious('x', '', '')).toBe(false)
  })
})

describe('checkInternalSecret', () => {
  it('is ok for the current or previous secret', () => {
    expect(checkInternalSecret('cur', 'cur', 'prev')).toBe('ok')
    expect(checkInternalSecret('prev', 'cur', 'prev')).toBe('ok')
  })

  it('is invalid for a missing, non-string or wrong value', () => {
    expect(checkInternalSecret(undefined, 'cur')).toBe('invalid')
    expect(checkInternalSecret('', 'cur')).toBe('invalid')
    expect(checkInternalSecret(['cur'], 'cur')).toBe('invalid')
    expect(checkInternalSecret('nope', 'cur', 'prev')).toBe('invalid')
  })

  it('is unconfigured without a current secret, whatever the caller sends', () => {
    expect(checkInternalSecret('anything', undefined)).toBe('unconfigured')
    expect(checkInternalSecret('', '')).toBe('unconfigured')
    expect(checkInternalSecret('prev', '', 'prev')).toBe('unconfigured')
  })

  it('names the lower-case header node:http and h3 use', () => {
    expect(INTERNAL_SECRET_HEADER).toBe('x-internal-secret')
  })
})

describe('cameThroughEdgeProxy', () => {
  const lookup = (headers: Record<string, string>) => (name: string) => headers[name]

  it('is true when Traefik forwarding headers are present', () => {
    expect(cameThroughEdgeProxy(lookup({ 'x-forwarded-server': 'traefik-1' }))).toBe(true)
    expect(cameThroughEdgeProxy(lookup({ 'x-forwarded-host': 'markoto.app' }))).toBe(true)
    expect(cameThroughEdgeProxy(lookup({ 'x-real-ip': '203.0.113.7' }))).toBe(true)
    expect(cameThroughEdgeProxy(lookup({ forwarded: 'for=203.0.113.7' }))).toBe(true)
  })

  it('is false for a direct call, including through the Nitro dev proxy', () => {
    expect(cameThroughEdgeProxy(lookup({}))).toBe(false)
    expect(cameThroughEdgeProxy(lookup({
      'x-forwarded-for': '127.0.0.1',
      'x-forwarded-port': '3000',
      'x-forwarded-proto': 'http'
    }))).toBe(false)
  })
})

describe('renderer copy', () => {
  it('is byte-identical to the shared helper (the renderer image is built from renderer/ only)', () => {
    const root = resolve(__dirname, '../../..')
    const shared = readFileSync(resolve(root, 'shared/utils/security/internalSecret.ts'), 'utf8')
    const copy = readFileSync(resolve(root, 'renderer/src/shared/utils/security/internalSecret.ts'), 'utf8')
    expect(copy).toBe(shared)
  })
})
