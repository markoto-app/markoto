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
    expect(oneScene).toBeGreaterThanOrEqual(1250)
    expect(oneScene).toBeLessThanOrEqual(1400)
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
  function steps(events: Array<[number, number]>): number {
    const g = newWheelGesture()
    return events.filter(([t, d]) => wheelSteps(g, t, d)).length
  }
  /** A trackpad swipe: deltas ramp up, then a long exponential momentum tail. */
  function swipe(start: number, frames = 140, peak = 40): Array<[number, number]> {
    const out: Array<[number, number]> = []
    for (let i = 0; i < 4; i++) out.push([start + i * 16, Math.round(peak * (i + 1) / 5)])
    for (let i = 0; i < frames; i++) out.push([start + (i + 4) * 16, Math.max(1, Math.round(peak * Math.exp(-i / 35)))])
    return out
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
    expect(steps(events)).toBe(1)
    expect(steps(swipe(1000))).toBe(1)
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

  it('a second swipe inside the first one\'s momentum tail is a new gesture', () => {
    // The first swipe's tail is still at ~6px/frame when the second starts.
    const first = swipe(1000, 60)
    const lastAt = first.at(-1)?.[0] ?? 1000
    expect(steps([...first, ...swipe(lastAt + 16)])).toBe(2)
  })

  it('jitter inside a tail is not a new swipe', () => {
    expect(steps([[1000, 40], [1016, 30], [1032, 18], [1048, 12], [1064, 15], [1080, 10], [1096, 13], [1112, 8]])).toBe(1)
    expect(steps([[1000, 40], [1016, 18], [1032, 2], [1048, 4], [1064, 3], [1080, 6], [1096, 5]])).toBe(1)
  })

  it('the ramp-up of one swipe is one gesture', () => {
    expect(steps([[1000, 2], [1016, 6], [1032, 14], [1048, 30], [1064, 45], [1080, 40], [1096, 30]])).toBe(1)
  })
})
