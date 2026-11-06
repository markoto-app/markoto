import { describe, expect, it } from 'vitest'
import {
  GESTURE_GAP_MS,
  GESTURE_MIN_DELTA,
  GLIDE_MAX_MS,
  GLIDE_MIN_MS,
  easeInOutSine,
  glideDuration,
  nearestRest,
  newWheelGesture,
  stepTarget,
  wheelSteps
} from '../../shared/tour/paging'

// Scene-by-scene paging of the product page (WP11): one wheel gesture or
// key = exactly one scene, never a skip or a double step.

describe('glide easing', () => {
  it('starts and ends at rest, symmetric around the middle', () => {
    expect(easeInOutSine(0)).toBeCloseTo(0, 9)
    expect(easeInOutSine(1)).toBe(1)
    expect(easeInOutSine(0.5)).toBeCloseTo(0.5, 6)
    expect(easeInOutSine(0.25) + easeInOutSine(0.75)).toBeCloseTo(1, 6)
    expect(easeInOutSine(-1)).toBeCloseTo(0, 9)
    expect(easeInOutSine(2)).toBe(1)
  })

  it('never moves faster than ~1.6x the average speed (no jump mid-glide)', () => {
    const steps = 1000
    let peak = 0
    for (let i = 0; i < steps; i++) peak = Math.max(peak, (easeInOutSine((i + 1) / steps) - easeInOutSine(i / steps)) * steps)
    expect(peak).toBeLessThan(1.6)
  })
})

describe('glide duration', () => {
  it('grows with the distance, within bounds', () => {
    const vh = 900
    const oneScene = glideDuration(1440, vh)
    expect(oneScene).toBeGreaterThanOrEqual(1500)
    expect(oneScene).toBeLessThanOrEqual(1700)
    expect(glideDuration(-1440, vh)).toBe(oneScene)
    expect(glideDuration(100, vh)).toBe(GLIDE_MIN_MS)
    expect(glideDuration(20 * vh, vh)).toBe(GLIDE_MAX_MS)
    expect(glideDuration(1440, 0)).toBeGreaterThanOrEqual(GLIDE_MIN_MS)
  })
})

describe('rest targets', () => {
  const rests = [0, 1236, 2676, 4116, 5000]

  it('finds the nearest rest', () => {
    expect(nearestRest(rests, 0)).toBe(0)
    expect(nearestRest(rests, 1300)).toBe(1)
    expect(nearestRest(rests, 4800)).toBe(4)
  })

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

describe('wheel gestures', () => {
  /** Feeds [time, delta] events; returns how many steps they produced. */
  function steps(events: Array<[number, number]>, gliding: (t: number) => boolean = () => false): number {
    const g = newWheelGesture()
    return events.filter(([t, d]) => wheelSteps(g, t, d, gliding(t))).length
  }

  it('one mouse-wheel notch = one step; a fast run of notches = one step', () => {
    expect(steps([[1000, 100]])).toBe(1)
    expect(steps([[1000, 100], [1060, 100], [1120, 100], [1180, 100]])).toBe(1)
  })

  it('notches with a pause between them step again', () => {
    expect(steps([[1000, 100], [1000 + GESTURE_GAP_MS + 50, 100]])).toBe(2)
  })

  it('a trackpad flick with a long momentum tail (longer than the glide) is one step', () => {
    const events: Array<[number, number]> = []
    for (let i = 0; i < 140; i++) events.push([1000 + i * 16, Math.max(1, Math.round(40 * Math.exp(-i / 35)))])
    expect(steps(events, t => t > 1000 && t < 2050)).toBe(1)
  })

  it('a stall inside a decaying tail does not start a new step', () => {
    expect(steps([[1000, 30], [1016, 24], [1032, 18], [1500, 12], [1516, 9]])).toBe(1)
  })

  it('a new flick after the tail (deltas rising again) steps again', () => {
    expect(steps([[1000, 30], [1016, 12], [1032, 2], [1500, 4], [1516, 14], [1532, 30]])).toBe(2)
  })

  it('a flick soon after a mouse notch is a new gesture, not its tail', () => {
    expect(steps([[1000, 120], [1600, 4], [1616, 10], [1632, 18]])).toBe(2)
  })

  it('a slow start (tiny deltas first) still steps once it is a real scroll', () => {
    expect(steps([[1000, 1], [1016, 2], [1032, GESTURE_MIN_DELTA], [1048, 8]])).toBe(1)
  })

  it('a gesture that begins during a glide is swallowed whole', () => {
    expect(steps([[1000, 40], [1016, 60], [1300, 50]], t => t < 1400)).toBe(0)
  })
})
