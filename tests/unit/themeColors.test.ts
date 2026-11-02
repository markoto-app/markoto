import { describe, expect, it } from 'vitest'
import {
  categoricalPalette,
  contrastRatio,
  hexToOklch,
  hexToRgb,
  mixHex,
  oklchToHex,
  readableOn,
  rgbToHex
} from '../../shared/utils/themeColors'

describe('themeColors', () => {
  it('parses and prints hex colours', () => {
    expect(hexToRgb('#fff')).toEqual({ r: 1, g: 1, b: 1 })
    expect(rgbToHex(hexToRgb('#0F5E63'))).toBe('#0f5e63')
    expect(hexToRgb('nonsense')).toEqual({ r: 0, g: 0, b: 0 })
  })

  it('round-trips through OKLCH', () => {
    for (const hex of ['#0f5e63', '#b5371f', '#12324a', '#8a96a3', '#ffffff', '#000000']) {
      expect(oklchToHex(hexToOklch(hex))).toBe(hex)
    }
  })

  it('clamps out-of-gamut colours into sRGB', () => {
    expect(oklchToHex({ l: 0.7, c: 0.5, h: 140 })).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('mixes and measures contrast like WCAG', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0)
    expect(readableOn('#0f5e63', '#1b2430')).toBe('#ffffff')
    expect(readableOn('#f2efe7', '#1b2430')).toBe('#1b2430')
  })

  it('builds an accent-led palette without duplicates, even from degenerate input', () => {
    const p = categoricalPalette({ accent: '#0f5e63', heading: '#12324a', neutral: '#8a96a3', background: '#ffffff' })
    expect(p[0]).toBe('#0f5e63')
    expect(p[1]).toBe('#12324a')
    expect(new Set(p).size).toBe(p.length)
    const flat = categoricalPalette({ accent: '#777777', heading: '#777777', neutral: '#777777', background: '#777777', size: 8 })
    expect(flat).toHaveLength(8)
  })
})
