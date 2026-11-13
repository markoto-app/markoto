import { describe, expect, it } from 'vitest'
import {
  SETTLE_ADVANCE_PX,
  SETTLE_MAX_MS,
  SETTLE_MIN_MS,
  nearestRest,
  settleDuration,
  settleEasing,
  settleTarget,
  stepTarget
} from '../../../shared/tour/paging'

// Settling the product page on a scene rest: the visitor scrolls
// freely; once the input stops the page settles on a rest, never springing
// back from a deliberate scroll, never skipping a scene.

// Hero, three scenes 1440px apart (160vh at 900px), page end.
const rests = [0, 1236, 2676, 4116, 5000]

describe('nearest rest', () => {
  it('finds the nearest rest', () => {
    expect(nearestRest(rests, 0)).toBe(0)
    expect(nearestRest(rests, 1300)).toBe(1)
    expect(nearestRest(rests, 4800)).toBe(4)
    expect(nearestRest([], 100)).toBe(0)
  })
})

describe('settle target', () => {
  it('stays on the rest it is on for a tiny scroll', () => {
    expect(settleTarget(rests, 1236 + SETTLE_ADVANCE_PX, 1, 1)).toBe(1)
    expect(settleTarget(rests, 1236 - 10, 1, -1)).toBe(1)
  })

  it('moves on after a short deliberate scroll (a notch, an arrow key, a small swipe)', () => {
    expect(settleTarget(rests, 1236 + 40, 1, 1)).toBe(2)
    expect(settleTarget(rests, 1236 - 100, 1, -1)).toBe(0)
  })

  it('goes to the nearest rest once past the middle, never skipping one', () => {
    expect(settleTarget(rests, 2100, 1, 1)).toBe(2)
    expect(settleTarget(rests, 2700, 1, 1)).toBe(2)
    expect(settleTarget(rests, 3500, 1, 1)).toBe(3)
  })

  it('does not reverse the input: a forward scroll that is still short of the rest settles on it', () => {
    // Heading to rest 2 (anchor) while a new swipe forward hasn't reached it yet.
    expect(settleTarget(rests, 2500, 2, 1)).toBe(2)
    // Past it: on to the next one.
    expect(settleTarget(rests, 2800, 2, 1)).toBe(3)
  })

  it('is clamped to the first and last rest', () => {
    expect(settleTarget(rests, 0, 0, -1)).toBe(0)
    expect(settleTarget(rests, 5000, 4, 1)).toBe(4)
  })
})

describe('paging keys', () => {
  it('steps to the next rest beyond the current position, clamped', () => {
    expect(stepTarget(rests, 0, 1)).toBe(1)
    expect(stepTarget(rests, 1236, 1)).toBe(2)
    expect(stepTarget(rests, 1236, -1)).toBe(0)
    // Between two rests: onwards in the direction, never back.
    expect(stepTarget(rests, 2000, 1)).toBe(2)
    expect(stepTarget(rests, 2000, -1)).toBe(1)
    expect(stepTarget(rests, 5000, 1)).toBe(4)
    expect(stepTarget(rests, 0, -1)).toBe(0)
    expect(stepTarget([], 10, 1)).toBe(0)
  })
})

describe('settle duration', () => {
  it('grows with the distance, within bounds', () => {
    const vh = 900
    expect(settleDuration(0, vh)).toBeGreaterThanOrEqual(SETTLE_MIN_MS)
    const half = settleDuration(720, vh)
    const whole = settleDuration(1440, vh)
    expect(half).toBeGreaterThan(settleDuration(0, vh))
    expect(whole).toBeGreaterThan(half)
    expect(settleDuration(-1440, vh)).toBe(whole)
    expect(settleDuration(100_000, vh)).toBe(SETTLE_MAX_MS)
  })
})

describe('settle easing', () => {
  const samples = (f: (t: number) => number) => Array.from({ length: 1001 }, (_, i) => f(i / 1000))

  it('goes from 0 to 1 and stops at the rest', () => {
    for (const m of [0, 0.5, 1, 2, 5, -3, Number.NaN]) {
      const f = settleEasing(m)
      expect(f(0)).toBeCloseTo(0, 9)
      expect(f(1)).toBeCloseTo(1, 9)
      // Arrives with zero speed.
      expect((f(1) - f(0.999)) * 1000).toBeLessThan(0.01)
    }
  })

  it('starts at the speed the page already moves at (no jolt at the hand-over)', () => {
    const f = settleEasing(1.2)
    expect((f(0.001) - f(0)) * 1000).toBeCloseTo(1.2, 1)
    expect((settleEasing(0)(0.001) - settleEasing(0)(0)) * 1000).toBeCloseTo(0, 1)
  })

  it('never overshoots or goes backwards, even for a fast or reversed start', () => {
    for (const m of [0, 1, 2, 10, -5]) {
      const ys = samples(settleEasing(m))
      for (let i = 1; i < ys.length; i++) {
        const y = ys[i] ?? 0
        expect(y).toBeGreaterThanOrEqual((ys[i - 1] ?? 0) - 1e-12)
        expect(y).toBeLessThanOrEqual(1 + 1e-12)
      }
    }
  })
})
