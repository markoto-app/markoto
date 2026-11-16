import { describe, expect, it } from 'vitest'
import { compareCodeUnits } from '../../../shared/utils/compareCodeUnits'

describe('compareCodeUnits', () => {
  it('orders like sort() without a comparator', () => {
    const values = ['b', 'B', 'a', '_x', 'Z', 'é', 'e', '10', '9', '', '2026-01-10', '2026-01-02']
    expect([...values].sort(compareCodeUnits)).toEqual(
      ['', '10', '2026-01-02', '2026-01-10', '9', 'B', 'Z', '_x', 'a', 'b', 'e', 'é']
    )
  })

  it('returns zero only for equal strings', () => {
    expect(compareCodeUnits('a', 'a')).toBe(0)
    expect(compareCodeUnits('a', 'b')).toBeLessThan(0)
    expect(compareCodeUnits('b', 'a')).toBeGreaterThan(0)
  })
})
