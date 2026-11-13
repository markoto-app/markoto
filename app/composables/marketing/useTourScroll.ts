import { nearestRest, settleDuration, settleEasing, settleTarget, stepTarget } from '~~/shared/tour/paging'
import { createTourLenis, LENIS_PREVENT, pageLocked } from './tourLenis'

/** Fired on `window` when the page comes to rest on a scene (detail: rest index). */
export const TOUR_REST_EVENT = 'mk-tour:rest'
/** Fired on `window` when the page scrolls away from the rest it was on (detail: that rest's index). */
export const TOUR_DEPART_EVENT = 'mk-tour:depart'

export interface TourRestDetail { index: number }

/** Reads a rest/depart event's index (`-1` for anything else). */
export function tourEventIndex(e: Event): number {
  if (!(e instanceof CustomEvent)) return -1
  const d: unknown = e.detail
  const i: unknown = typeof d === 'object' && d !== null ? Reflect.get(d, 'index') : undefined
  return typeof i === 'number' ? i : -1
}

export interface TourScrollOptions {
  /** Rest positions in document px, top to bottom (hero, scenes…, page end). */
  rests: () => number[]
  /** Whether the smooth scroll is wanted right now (the pinned desktop layout). */
  active: () => boolean
  /** Media query whose changes may switch `active` (resize across the breakpoint). */
  activeQuery: string
}

/** No wheel input for this long: the visitor has stopped (a trackpad's
 *  momentum tail sends an event every frame until it is over). */
const WHEEL_IDLE_MS = 160
/** No native scroll (keys, scrollbar, find-in-page) for this long. */
const NATIVE_IDLE_MS = 140
/** Further than this from the rest it was on, the page has left it. */
const DEPART_PX = 8
/** Within this of a rest, native scrolling has come to rest on it. */
const AT_REST_PX = 4
/** Keys the browser scrolls the page with (taken over while Lenis runs). */
const SCROLL_KEYS = new Set(['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', ' ', 'Home', 'End'])

/** A paging key the tour takes over: not typed into a field, not pressing a button, and the page isn't locked. */
function isTourPagingKey(e: KeyboardEvent): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented || !SCROLL_KEYS.has(e.key)) return false
  const target = e.target
  if (target instanceof HTMLElement && (target.isContentEditable || target.closest(LENIS_PREVENT + ', input'))) return false
  // Space on a button or link presses it.
  if (e.key === ' ' && target instanceof HTMLElement && target.closest('button, a, summary, [role="button"]')) return false
  return !pageLocked()
}

/**
 * The rest a paging key goes to: Home / End the first / last; otherwise the
 * next one in `dir`, counted from the rest a running settle is heading for
 * (`anchor`: a key pressed during a settle goes one further), else from
 * where the scroll is going (`targetScroll`).
 */
function pagingKeyRest(key: string, rests: number[], from: { anchor: number } | { targetScroll: number }, dir: 1 | -1): number {
  if (key === 'Home') return 0
  if (key === 'End') return rests.length - 1
  if ('anchor' in from) return Math.min(rests.length - 1, Math.max(0, from.anchor + dir))
  return stepTarget(rests, from.targetScroll, dir)
}

/**
 * Scrolling of the product page's pinned desktop layout.
 *
 * The visitor scrolls the page themselves, every wheel notch and every
 * trackpad swipe moves it, continuously driving the CSS scroll-driven
 * choreography: and once the input stops the page settles on a scene
 * rest (`settleTarget`: the nearest one, or the next one in the direction
 * of travel when the visitor has left the rest they were on, so a short
 * swipe never springs back). Wheel and trackpad input is smoothed by
 * Lenis (https://github.com/darkroomengineering/lenis), loaded with a
 * dynamic import after `load` + idle, only while the layout is pinned
 * (destroyed on unmount or when a resize leaves the pinned layout). The
 * settle starts at the speed the page is already moving (`settleEasing`),
 * so there is no pause and no jolt where the visitor's scroll hands over.
 * Paging keys (PageUp/PageDown/Space/arrows/Home/End) scroll straight to
 * the next rest with the same settle; the scrollbar and find-in-page scroll
 * natively and settle once they stop. Before Lenis has loaded (or without
 * it) native scrolling with CSS `proximity` snapping does the job.
 *
 * `TOUR_REST_EVENT` / `TOUR_DEPART_EVENT` tell the scenes when one has
 * settled (the share scene fans its PDF pages out then).
 */
export function useTourScroll(opts: TourScrollOptions) {
  let media: MediaQueryList | null = null
  let started = false

  /** The rest the page last settled on (or is settling on): stepping counts from here. */
  let anchor = 0
  /** The rest the page sits on right now (-1 = between rests). */
  let rested = -1
  let restedY = 0
  let settling = false
  /** Direction of the latest input: 1 down, -1 up. */
  let dir: 1 | -1 = 1
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let draggingScrollbar = false
  // Scroll speed (px/ms), measured over the last frames.
  let lastY = 0
  let lastAt = 0
  let speed = 0
  let lastNativeY = 0

  function emit(name: string, index: number): void {
    window.dispatchEvent(new CustomEvent<TourRestDetail>(name, { detail: { index } }))
  }
  function markRest(index: number, y: number): void {
    anchor = index
    restedY = y
    if (index === rested) return
    rested = index
    emit(TOUR_REST_EVENT, index)
  }

  function scheduleIdle(ms: number): void {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(onIdle, ms)
  }

  function onIdle(): void {
    if (draggingScrollbar || pageLocked()) return
    const rests = opts.rests()
    const lenis = host.current()
    if (!lenis) {
      // Native scrolling (CSS proximity snapping): note where it stopped.
      const i = nearestRest(rests, window.scrollY)
      const at = rests[i]
      if (at !== undefined && Math.abs(at - window.scrollY) <= AT_REST_PX) markRest(i, at)
      return
    }
    settleTo(settleTarget(rests, lenis.targetScroll, anchor, dir), true)
  }

  /** Smoothly scroll to rest `index`; `carry`: start at the current speed. */
  function settleTo(index: number, carry: boolean): void {
    const to = opts.rests()[index]
    if (to === undefined) return
    const lenis = host.current()
    if (!lenis) {
      window.scrollTo({ top: to, behavior: 'smooth' })
      return
    }
    const from = lenis.animatedScroll
    const distance = to - from
    if (Math.abs(distance) < 1) {
      settling = false
      markRest(index, to)
      return
    }
    const ms = settleDuration(distance, window.innerHeight)
    anchor = index
    settling = true
    lenis.scrollTo(to, {
      duration: ms / 1000,
      easing: settleEasing(carry ? speed * ms / distance : 0),
      userData: { initiator: 'tour-settle' },
      onComplete: () => {
        settling = false
        markRest(index, to)
      }
    })
  }

  function onScroll(): void {
    const y = window.scrollY
    const now = performance.now()
    const dt = now - lastAt
    if (dt > 0 && dt < 100) speed = (y - lastY) / dt
    else speed = 0
    lastY = y
    lastAt = now
    if (rested >= 0 && Math.abs(y - restedY) > DEPART_PX) {
      emit(TOUR_DEPART_EVENT, rested)
      rested = -1
    }
    // Lenis animating (smoothed wheel input, a settle) schedules itself;
    // anything else is native scrolling: keys, scrollbar, find-in-page.
    if (host.current()?.isScrolling === 'smooth') return
    if (y !== lastNativeY) dir = y > lastNativeY ? 1 : -1
    lastNativeY = y
    scheduleIdle(NATIVE_IDLE_MS)
  }

  function onWheelInput(e: { deltaY: number }): void {
    if (e.deltaY === 0) return
    dir = e.deltaY > 0 ? 1 : -1
    settling = false
    scheduleIdle(WHEEL_IDLE_MS)
  }

  // Paging keys: the browser's own key scrolling is a quick jump (PageDown
  // ≈ 0.9 viewport in ~150 ms) that the settle would then have to finish
  // after a pause, so with Lenis running a paging key scrolls straight to
  // the next rest (a key pressed during a settle goes one further).
  function onKeyDown(e: KeyboardEvent): void {
    const lenis = host.current()
    if (!lenis || !isTourPagingKey(e)) return
    e.preventDefault()
    const rests = opts.rests()
    const back = e.key === 'PageUp' || e.key === 'ArrowUp' || (e.key === ' ' && e.shiftKey)
    dir = back ? -1 : 1
    settleTo(pagingKeyRest(e.key, rests, settling ? { anchor } : { targetScroll: lenis.targetScroll }, dir), true)
  }
  function onPointerDown(e: PointerEvent): void {
    // A press on the page's scrollbar (right of the layout viewport).
    if (e.target === document.documentElement && e.clientX >= document.documentElement.clientWidth) draggingScrollbar = true
  }
  function onPointerUp(): void {
    if (!draggingScrollbar) return
    draggingScrollbar = false
    scheduleIdle(NATIVE_IDLE_MS)
  }

  const host = createTourLenis({
    active: opts.active,
    started: () => started,
    onWheel: onWheelInput,
    onDestroyed: () => {
      settling = false
    }
  })

  function start(): void {
    started = true
    lastY = lastNativeY = window.scrollY
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('keydown', onKeyDown)
    document.documentElement.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    media = window.matchMedia(opts.activeQuery)
    media.addEventListener('change', host.onMediaChange)
    const rests = opts.rests()
    const i = nearestRest(rests, window.scrollY)
    const at = rests[i]
    anchor = i
    if (at !== undefined && Math.abs(at - window.scrollY) <= AT_REST_PX) markRest(i, at)
    if (opts.active()) host.load()
  }
  function stop(): void {
    started = false
    window.removeEventListener('scroll', onScroll)
    window.removeEventListener('keydown', onKeyDown)
    document.documentElement.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('pointerup', onPointerUp)
    media?.removeEventListener('change', host.onMediaChange)
    media = null
    host.cancelLoading()
    clearTimeout(idleTimer)
    host.destroy()
  }
  function goTo(index: number): void {
    dir = index >= anchor ? 1 : -1
    settleTo(index, false)
  }
  return { start, stop, goTo }
}
