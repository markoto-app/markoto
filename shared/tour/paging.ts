// Scene-to-scene paging of the product page (WP11): pure helpers behind
// app/composables/useTourPager.ts, unit-tested in tests/unit/tourPaging.test.ts.

/** Scene-to-scene glide duration: a base plus a share per viewport height
 *  travelled, clamped. One scene (1.6 viewports) takes ~1.3 s — the copy
 *  fade, stage slide and cross-fade are spread over the whole crossing
 *  (ProductTour), so this is long enough to follow them and short enough
 *  that the page doesn't feel held back. */
export const GLIDE_BASE_MS = 600
export const GLIDE_MS_PER_VIEWPORT = 450
export const GLIDE_MIN_MS = 1000
export const GLIDE_MAX_MS = 1800

/** How long a glide over `distance` px takes in a `viewport` px tall window. */
export function glideDuration(distance: number, viewport: number): number {
  const viewports = viewport > 0 ? Math.abs(distance) / viewport : 1
  const ms = GLIDE_BASE_MS + GLIDE_MS_PER_VIEWPORT * viewports
  return Math.min(GLIDE_MAX_MS, Math.max(GLIDE_MIN_MS, ms))
}

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

/** A delta this many times the previous one, and at least `RISE_MIN_PX`
 *  larger, after the gesture had decayed to under half its peak: a NEW
 *  swipe started inside the previous one's momentum tail. */
export const RISE_RATIO = 1.6
export const RISE_MIN_PX = 6

/** Per-page state of the wheel gesture currently in progress. */
export interface WheelGesture {
  /** Events up to this time belong to the current gesture. */
  until: number
  lastAt: number
  lastDelta: number
  /** Largest delta of the current gesture. */
  peak: number
  /** The current gesture has fallen to under half its peak (a momentum tail). */
  decayed: boolean
  /** The current gesture has already produced its step. */
  fired: boolean
}

export function newWheelGesture(): WheelGesture {
  return { until: 0, lastAt: -Infinity, lastDelta: 0, peak: 0, decayed: false, fired: false }
}

/**
 * Feeds one wheel event (time, deltaY) into the gesture state; true when a
 * NEW gesture has started that should move one scene (the pager steps at
 * once, or queues the step while a glide runs). One step per gesture: a
 * run of notches, a trackpad swipe with its momentum tail — even one whose
 * tail outlasts the glide or stalls for a moment — counts once. A new
 * gesture is either input after a pause (`GESTURE_GAP_MS`, unless it
 * continues a decaying tail) or a swipe that starts inside the previous
 * one's momentum tail: the deltas, having decayed, rise sharply again.
 */
export function wheelSteps(g: WheelGesture, now: number, deltaY: number): boolean {
  const d = Math.abs(deltaY)
  const decayingTail = now - g.lastAt < TAIL_STALL_MS && d < g.lastDelta && d >= g.lastDelta * TAIL_MIN_RATIO
  const afterPause = now > g.until && !decayingTail
  const risingAgain = !afterPause && g.decayed && d >= g.lastDelta * RISE_RATIO && d - g.lastDelta >= RISE_MIN_PX
  if (afterPause || risingAgain) {
    g.peak = d
    g.decayed = false
    g.fired = false
  } else {
    g.peak = Math.max(g.peak, d)
    if (d < g.peak / 2) g.decayed = true
  }
  g.until = now + GESTURE_GAP_MS
  g.lastAt = now
  g.lastDelta = d
  if (g.fired || d < GESTURE_MIN_DELTA) return false
  g.fired = true
  return true
}

/**
 * Ease-in-out (sine): soft start, soft arrival, and a mid-glide peak speed
 * of ~1.57× the average (a cubic curve peaks at 3×, which reads as a jump
 * between scenes).
 */
export function easeInOutSine(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return -(Math.cos(Math.PI * x) - 1) / 2
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
