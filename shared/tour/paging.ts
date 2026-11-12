// Scene rests of the product page: pure helpers behind
// app/composables/marketing/useTourScroll.ts, unit-tested in tests/unit/seo/tourPaging.test.ts.
//
// The visitor scrolls the page themselves (Lenis smooths wheel and
// trackpad input on the pinned layout); once the input stops, the page
// settles on a scene rest. These helpers pick that rest and shape the
// settle so it continues the motion already under way.

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

/** A scroll this far (px) away from the rest the page last settled on
 *  counts as "go on" even when that rest is still the nearest: a short
 *  trackpad swipe, a mouse notch or an arrow key (40 px in Chromium) moves
 *  on to the next scene instead of springing back, no input is ignored. */
export const SETTLE_ADVANCE_PX = 24

/**
 * The rest to settle on once the input has stopped at `y` (where the
 * scroll is heading, not where it is this frame); `from` is the rest the
 * page last settled on (or is settling on), `dir` the direction of the
 * latest input (1 down, -1 up). Normally the nearest rest; but when that is
 * still `from` and the visitor has moved more than `advancePx` away from
 * it in the direction of the input, the next rest that way, a short
 * scroll moves on instead of springing back, and a scroll is never turned
 * around (a forward swipe short of the rest it heads for stays there).
 */
export function settleTarget(rests: readonly number[], y: number, from: number, dir: 1 | -1, advancePx = SETTLE_ADVANCE_PX): number {
  const near = nearestRest(rests, y)
  const at = rests[near]
  if (near !== from || at === undefined) return near
  const moved = y - at
  if (Math.abs(moved) <= advancePx || Math.sign(moved) !== dir) return near
  const next = near + dir
  return next >= 0 && next < rests.length ? next : near
}

/**
 * The rest one step from `y` in direction `dir` (a paging key): the first
 * rest beyond `y` (more than `tolerance` px away), so a step taken between
 * two rests goes to the next one, never back, clamped to the first / last
 * rest.
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

/** Settle duration: a base plus a share per viewport travelled, clamped.
 *  Half a scene (0.8 viewports) takes ~0.75 s; a whole scene ~1.1 s. */
const SETTLE_BASE_MS = 380
const SETTLE_MS_PER_VIEWPORT = 460
export const SETTLE_MIN_MS = 350
export const SETTLE_MAX_MS = 1300

/** How long settling over `distance` px takes in a `viewport` px tall window. */
export function settleDuration(distance: number, viewport: number): number {
  const viewports = viewport > 0 ? Math.abs(distance) / viewport : 1
  const ms = SETTLE_BASE_MS + SETTLE_MS_PER_VIEWPORT * viewports
  return Math.min(SETTLE_MAX_MS, Math.max(SETTLE_MIN_MS, ms))
}

/** Start slope cap: a settle may start at most this many times faster
 *  than its average speed (higher would overshoot the rest). */
const SETTLE_MAX_START_SLOPE = 2

/**
 * Easing for a settle that starts while the page is still moving: a cubic
 * Hermite curve from the current speed to a stop at the rest, so there is
 * no jolt where the visitor's own scroll hands over to the settle.
 * `startSlope` = current speed ÷ the settle's average speed (velocity px/ms
 * × duration ms ÷ distance px); 0 (from standstill) gives a smoothstep.
 * Moving away from the rest (negative) or too fast is clamped to [0, 2].
 */
export function settleEasing(startSlope: number): (t: number) => number {
  const m = Number.isFinite(startSlope) ? Math.min(SETTLE_MAX_START_SLOPE, Math.max(0, startSlope)) : 0
  return (t: number) => {
    const x = Math.min(1, Math.max(0, t))
    // h10 · m + h01: p(0) = 0, p'(0) = m, p(1) = 1, p'(1) = 0.
    return (x * x * x - 2 * x * x + x) * m + (3 * x * x - 2 * x * x * x)
  }
}
