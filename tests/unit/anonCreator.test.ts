import { describe, it, expect } from 'vitest'
import {
  anonCreatorKeyMatches,
  hashAnonCreatorKey,
  parseAnonCreatorKey
} from '../../server/utils/anonCreator'

// Creator key for anonymous documents: only the browser holding the key
// whose hash is stored on the doc row may delete it.

const KEY = 'a'.repeat(43)
const OTHER = 'b'.repeat(43)

describe('parseAnonCreatorKey', () => {
  it('accepts a 43-character base64url key', () => {
    expect(parseAnonCreatorKey(KEY)).toBe(KEY)
    expect(parseAnonCreatorKey('Ab-_'.repeat(10) + 'xyz')).toHaveLength(43)
  })

  it('rejects anything else', () => {
    expect(parseAnonCreatorKey(undefined)).toBeNull()
    expect(parseAnonCreatorKey('')).toBeNull()
    expect(parseAnonCreatorKey('a'.repeat(42))).toBeNull()
    expect(parseAnonCreatorKey(`${'a'.repeat(42)}=`)).toBeNull()
  })
})

describe('anonCreatorKeyMatches', () => {
  it('stores a SHA-256 hex hash, never the key', () => {
    const hash = hashAnonCreatorKey(KEY)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain(KEY)
  })

  it('matches only the key the hash was made from', () => {
    const hash = hashAnonCreatorKey(KEY)
    expect(anonCreatorKeyMatches(KEY, hash)).toBe(true)
    expect(anonCreatorKeyMatches(OTHER, hash)).toBe(false)
  })

  it('never matches without a key or for a legacy doc without a stored hash', () => {
    expect(anonCreatorKeyMatches(null, hashAnonCreatorKey(KEY))).toBe(false)
    expect(anonCreatorKeyMatches(KEY, null)).toBe(false)
    expect(anonCreatorKeyMatches(KEY, '')).toBe(false)
    expect(anonCreatorKeyMatches(KEY, 'not-hex')).toBe(false)
  })
})
