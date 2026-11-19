import { describe, it, expect } from 'vitest'
import { decodeDocCursor, encodeDocCursor } from '../../../server/utils/explorer/docCursor'

const enc = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url')

describe('document list cursor', () => {
  it('round-trips a timestamp key with microseconds and a document id', () => {
    const key = '2026-11-18 10:11:12.123456+00'
    const cursor = encodeDocCursor(key, 'AbC_12-x')
    expect(cursor).toMatch(/^[\w-]+$/)
    expect(decodeDocCursor(cursor)).toEqual({ key, docId: 'AbC_12-x' })
  })

  it('round-trips a title key with any characters', () => {
    const key = 'über "quotes", [brackets] & ü'
    expect(decodeDocCursor(encodeDocCursor(key, 'd1'))).toEqual({ key, docId: 'd1' })
  })

  it('returns null for a missing or empty cursor', () => {
    expect(decodeDocCursor(undefined)).toBeNull()
    expect(decodeDocCursor('')).toBeNull()
  })

  it('refuses anything this server did not make', () => {
    for (const raw of [
      'not base64 json',
      enc({ key: 'a', docId: 'b' }),
      enc(['a']),
      enc(['a', 'b', 'c']),
      enc([1, 'b']),
      enc(['a', 2]),
      enc(['a', 'bad id with spaces']),
      enc(['a', 'x'.repeat(65)]),
      enc(['k'.repeat(201), 'b']),
      enc(['a', ''])
    ]) {
      expect(decodeDocCursor(raw), raw).toBeNull()
    }
  })
})
