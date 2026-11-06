import { describe, expect, it } from 'vitest'
import {
  categoricalPalette,
  colorAtGreyLightness,
  contrastRatio,
  greyLightness,
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

  it('measures greyscale lightness from luminance', () => {
    expect(greyLightness('#000000')).toBe(0)
    expect(greyLightness('#ffffff')).toBeCloseTo(1, 5)
    // Pure blue prints far darker than its OKLCH lightness suggests.
    expect(greyLightness('#0000ff')).toBeLessThan(hexToOklch('#0000ff').l)
    for (const target of [0.3, 0.45, 0.6]) {
      expect(greyLightness(colorAtGreyLightness(30, 0.12, target))).toBeCloseTo(target, 2)
      expect(greyLightness(colorAtGreyLightness(250, 0.15, target))).toBeCloseTo(target, 2)
    }
  })

  // A chart printed in black and white: with n series, entries 0..n-1
  // are drawn next to each other, and in a pie the last slice touches the
  // first. Every such neighbour pair must print as a clearly different grey.
  const accents = ['#0f5e63', '#b5371f', '#3b82f6', '#0891b2', '#b45309', '#4c1d95', '#047857', '#2f5b7c', '#111111', '#e11d48', '#facc15', '#22c55e']
  const headings = ['#12324a', '#111827', '#1f1b14', '#b45309']
  it.each(accents)('separates neighbouring entries in greyscale (accent %s)', (accent) => {
    for (const heading of headings) {
      const p = categoricalPalette({ accent, heading, neutral: '#94a3b8', background: '#ffffff', maxLightness: 0.62 })
      const grey = p.map(greyLightness)
      for (let n = 2; n <= 6; n++) {
        for (let i = 0; i < n; i++) {
          if (n === 2 && i === 1) continue
          const gap = Math.abs((grey[i] ?? 0) - (grey[(i + 1) % n] ?? 0))
          // ≈0.02 is a just-noticeable step; few series (the common case) get much more.
          expect(gap, `${accent}/${heading}: ${n} series, ${p[i]} next to ${p[(i + 1) % n]}`).toBeGreaterThanOrEqual(n <= 3 ? 0.1 : 0.05)
        }
      }
      // The six levels are all distinct greys, and stay dark enough for white labels.
      const six = grey.slice(0, 6).sort((a, b) => a - b)
      for (let i = 1; i < 6; i++) expect((six[i] ?? 0) - (six[i - 1] ?? 0), `${accent}/${heading} levels`).toBeGreaterThanOrEqual(0.03)
      for (const hex of p) expect(contrastRatio(hex, '#ffffff'), `${accent}/${heading} ${hex}`).toBeGreaterThanOrEqual(3.5)
    }
  })

  it('keeps the accent exact unless it is too light for white labels', () => {
    expect(categoricalPalette({ accent: '#b5371f', heading: '#1f1b14', neutral: '#a39a8a', background: '#ffffff', maxLightness: 0.62 })[0]).toBe('#b5371f')
    const light = categoricalPalette({ accent: '#facc15', heading: '#111827', neutral: '#9ca3af', background: '#ffffff', maxLightness: 0.62 })[0] ?? ''
    expect(greyLightness(light)).toBeCloseTo(0.62, 2)
    expect(hexToOklch(light).h).toBeCloseTo(hexToOklch('#facc15').h, -1)
  })
})
