import { describe, expect, it } from 'vitest'
import { jsonEqual } from '../../shared/utils/jsonEqual'
import { THEME_PRESETS } from '../../shared/utils/themePresets'

describe('jsonEqual', () => {
  it('ignores object key order (a theme read back from jsonb)', () => {
    expect(jsonEqual({ a: 1, b: { c: [1, 2], d: 'x' } }, { b: { d: 'x', c: [1, 2] }, a: 1 })).toBe(true)
  })

  it('a built-in preset equals its key-shuffled jsonb round-trip', () => {
    const preset = THEME_PRESETS[0].theme
    // Reverse the key order at every level, like jsonb's own ordering would.
    const reverseKeys = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(reverseKeys)
      if (typeof v !== 'object' || v === null) return v
      return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]))
    }
    const shuffled = reverseKeys(preset)
    expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(preset))
    expect(jsonEqual(preset, shuffled)).toBe(true)
  })

  it('detects real differences', () => {
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(jsonEqual([1, 2], [2, 1])).toBe(false)
    expect(jsonEqual({ a: null }, { a: 0 })).toBe(false)
    expect(jsonEqual([1], { 0: 1 })).toBe(false)
  })

  it('treats a missing key and an undefined value alike (JSON drops both)', () => {
    expect(jsonEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true)
  })
})
