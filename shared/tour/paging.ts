// Scene-to-scene paging of the product page (WP11): pure helpers behind
// app/composables/useTourPager.ts, unit-tested in tests/unit/tourPaging.test.ts.

/** How long one scene-to-scene glide takes (ms). Long enough for the
 *  scroll-tied copy fade, stage slide and colour flip to be seen. */
export const GLIDE_MS = 1050

/** Wheel events closer together than this belong to one gesture (a run
 *  of notches, a trackpad flick and its momentum tail). */
export const GESTURE_GAP_MS = 300

/** A wheel event smaller than this (px) never starts a step: a fading
 *  momentum tail, or the first trickle of a slow scroll. */
export const GESTURE_MIN_DELTA = 4

/** A gap shorter than this between smoothly DECREASING deltas is still the
 *  same momentum tail (an input stall mid-tail must not count as a new
 *  flick). Smoothly: a tail decays gradually, so the next delta is at least
 *  `TAIL_MIN_RATIO` of the previous one — a small delta after a big one
 *  (a flick after a mouse notch) starts a new gesture. */
export const TAIL_STALL_MS = 700
export const TAIL_MIN_RATIO = 0.4

/** Per-page state of the wheel gesture currently in progress. */
export interface WheelGesture {
  /** Events up to this time belong to the current gesture. */
  until: number
  lastAt: number
  lastDelta: number
  /** The current gesture has already stepped (or began during a glide). */
  used: boolean
}

export function newWheelGesture(): WheelGesture {
  return { until: 0, lastAt: -Infinity, lastDelta: 0, used: false }
}

/**
 * Feeds one wheel event (time, deltaY, whether a glide is running) into the
 * gesture state; true when it should step one scene. One step per gesture:
 * a run of notches, a trackpad flick with its momentum tail — even one
 * whose tail outlasts the glide or stalls for a moment — moves exactly one
 * scene. A gesture that begins while a glide runs is swallowed whole.
 */
export function wheelSteps(g: WheelGesture, now: number, deltaY: number, gliding: boolean): boolean {
  const d = Math.abs(deltaY)
  const decayingTail = now - g.lastAt < TAIL_STALL_MS && d < g.lastDelta && d >= g.lastDelta * TAIL_MIN_RATIO
  if (now > g.until && !decayingTail) g.used = gliding
  g.until = now + GESTURE_GAP_MS
  g.lastAt = now
  g.lastDelta = d
  if (g.used || gliding || d < GESTURE_MIN_DELTA) return false
  g.used = true
  return true
}

/** Ease-in-out (cubic): slow start, slow arrival. */
export function easeInOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

/** Index of the rest position nearest to `y`. */
export function nearestRest(rests: readonly number[], y: number): number {
  let best = 0
  for (let i = 1; i < rests.length; i++) {
    const r = rests[i]
    const b = rests[best]
    if (r !== undefined && b !== undefined && Math.abs(r - y) < Math.abs(b - y)) best = i
  }
  return best
}

/**
 * The rest one step from `y` in direction `dir`: the first rest beyond `y`
 * (more than `tolerance` px away) — so a step taken between two rests goes
 * to the next one, never back — clamped to the first / last rest.
 */
export function stepTarget(rests: readonly number[], y: number, dir: 1 | -1, tolerance = 2): number {
  if (rests.length === 0) return 0
  if (dir > 0) {
    const i = rests.findIndex(r => r > y + tolerance)
    return i === -1 ? rests.length - 1 : i
  }
  for (let i = rests.length - 1; i >= 0; i--) {
    const r = rests[i]
    if (r !== undefined && r < y - tolerance) return i
  }
  return 0
}
