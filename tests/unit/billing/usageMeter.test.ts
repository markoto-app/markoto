import { describe, it, expect } from 'vitest'
import { formatBytes, usageFill } from '../../../app/utils/billing/usageMeter'

describe('usageFill', () => {
  it('buckets by used share: < 75 % ok, ≥ 75 % warning, ≥ 90 % critical', () => {
    expect(usageFill(0, 100)).toEqual({ unlimited: false, pct: 0, level: 'ok' })
    expect(usageFill(74, 100).level).toBe('ok')
    expect(usageFill(75, 100).level).toBe('warning')
    expect(usageFill(89, 100).level).toBe('warning')
    expect(usageFill(90, 100).level).toBe('critical')
  })

  it('at or over the cap is critical and clamps to 100 %', () => {
    expect(usageFill(1, 1)).toEqual({ unlimited: false, pct: 100, level: 'critical' })
    expect(usageFill(7, 5)).toEqual({ unlimited: false, pct: 100, level: 'critical' })
    // 1999 of 2000 rounds to 100 % but is a real near-cap value.
    expect(usageFill(1999, 2000).level).toBe('critical')
  })

  it('a null / non-finite limit is unlimited with an empty bar', () => {
    expect(usageFill(5, null)).toEqual({ unlimited: true, pct: 0, level: 'ok' })
    expect(usageFill(5, undefined).unlimited).toBe(true)
    expect(usageFill(5, Infinity).unlimited).toBe(true)
    expect(usageFill(5, Number.NaN).unlimited).toBe(true)
  })

  it('a zero limit is full, never a division by zero', () => {
    expect(usageFill(0, 0)).toEqual({ unlimited: false, pct: 100, level: 'critical' })
  })
})

describe('formatBytes', () => {
  it('formats B / KB / MB / GB with one decimal', () => {
    expect(formatBytes(null)).toBe('')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(100 * 1024 * 1024)).toBe('100.0 MB')
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB')
  })
})
