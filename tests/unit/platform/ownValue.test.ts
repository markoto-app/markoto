import { describe, expect, it } from 'vitest'
import { ownValue } from '../../../shared/utils/ownValue'
import { isAudienceKind } from '../../../shared/audiences'

// Lookups keyed by request input answer only for the table's own keys:
// names every object inherits must not pass as supported values.

const INHERITED = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf']

describe('ownValue', () => {
  const table: Record<string, string> = { 'image/png': 'png' }
  it('answers for own keys only', () => {
    expect(ownValue(table, 'image/png')).toBe('png')
    expect(ownValue(table, 'image/svg+xml')).toBeUndefined()
    for (const key of INHERITED) expect(ownValue(table, key), key).toBeUndefined()
  })
})

describe('isAudienceKind', () => {
  it('accepts the audience kinds and refuses inherited names', () => {
    expect(isAudienceKind('business')).toBe(true)
    for (const key of INHERITED) expect(isAudienceKind(key), key).toBe(false)
    expect(isAudienceKind(5)).toBe(false)
  })
})
