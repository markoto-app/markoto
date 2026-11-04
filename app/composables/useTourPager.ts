import { easeInOutCubic, GLIDE_MS, nearestRest, newWheelGesture, stepTarget, wheelSteps } from '~~/shared/tour/paging'

/** Fired on `window` when the page comes to rest on a scene (detail: rest index). */
export const TOUR_REST_EVENT = 'mk-tour:rest'
/** Fired on `window` when a glide away from the current rest starts (detail: target rest index). */
export const TOUR_DEPART_EVENT = 'mk-tour:depart'

export interface TourRestDetail { index: number }

/** Reads a rest/depart event's index (`-1` for anything else). */
export function tourEventIndex(e: Event): number {
  if (!(e instanceof CustomEvent)) return -1
  const d: unknown = e.detail
  const i: unknown = typeof d === 'object' && d !== null ? Reflect.get(d, 'index') : undefined
  return typeof i === 'number' ? i : -1
}

export interface TourPagerOptions {
  /** Rest positions in document px, top to bottom (hero, scenes…, page end). */
  rests: () => number[]
  /** Whether stepping is wanted right now (the pinned desktop layout). */
  active: () => boolean
}

/**
 * Scene-by-scene paging of the product page's pinned desktop layout.
 *
 * CSS snaps the page (`mandatory`, one rest per scene), but the native
 * snap is a quick jump — and in Chromium a short wheel gesture springs
 * back. So every wheel/trackpad gesture and every paging key becomes ONE
 * step to the next (or previous) rest, glided over `GLIDE_MS` with an
 * ease-in-out curve: long enough for the scroll-tied copy fade, stage
 * slide and colour flip to play. While gliding, snapping is switched off
 * (it would catch every intermediate frame) and further input is
 * swallowed; the rest of a gesture (more notches, a trackpad's momentum
 * tail) is swallowed too, so nothing skips or double-steps. Scrollbar
 * drags and touch keep the native snapping.
 *
 * `TOUR_REST_EVENT` / `TOUR_DEPART_EVENT` tell the scenes when one has
 * settled (the share scene fans its PDF pages out then).
 */
export function useTourPager(opts: TourPagerOptions) {
  let gliding = false
  let raf = 0
  const gesture = newWheelGesture()
  let lastRest = -1
  let settleTimer: ReturnType<typeof setTimeout> | undefined

  function emit(name: string, index: number): void {
    window.dispatchEvent(new CustomEvent<TourRestDetail>(name, { detail: { index } }))
  }
  function settle(index: number): void {
    if (index === lastRest) return
    lastRest = index
    emit(TOUR_REST_EVENT, index)
  }
  function snapping(on: boolean): void {
    const s = document.documentElement.style
    s.scrollSnapType = on ? '' : 'none'
    s.scrollBehavior = on ? '' : 'auto'
  }

  function glideTo(index: number): void {
    const to = opts.rests()[index]
    if (to === undefined) return
    const from = window.scrollY
    if (Math.abs(to - from) < 2) {
      settle(index)
      return
    }
    gliding = true
    lastRest = -1
    emit(TOUR_DEPART_EVENT, index)
    snapping(false)
    const start = performance.now()
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / GLIDE_MS)
      window.scrollTo(0, from + (to - from) * easeInOutCubic(p))
      if (p < 1) {
        raf = requestAnimationFrame(tick)
        return
      }
      snapping(true)
      gliding = false
      settle(index)
    }
    raf = requestAnimationFrame(tick)
  }
  function step(dir: 1 | -1): void {
    glideTo(stepTarget(opts.rests(), window.scrollY, dir))
  }

  function pageLocked(target: EventTarget | null): boolean {
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [role="dialog"]'))) return true
    // A modal's scroll lock: the page isn't scrollable right now.
    return getComputedStyle(document.body).overflowY === 'hidden' || getComputedStyle(document.documentElement).overflowY === 'hidden'
  }

  function onWheel(e: WheelEvent): void {
    if (e.ctrlKey || e.defaultPrevented || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    if (!opts.active() || pageLocked(e.target)) return
    e.preventDefault()
    if (wheelSteps(gesture, performance.now(), e.deltaY, gliding)) step(e.deltaY > 0 ? 1 : -1)
  }

  const FORWARD = new Set(['PageDown', 'ArrowDown', ' '])
  const BACK = new Set(['PageUp', 'ArrowUp'])
  function onKey(e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return
    const key = e.key
    const forward = FORWARD.has(key) && !(key === ' ' && e.shiftKey)
    const back = BACK.has(key) || (key === ' ' && e.shiftKey)
    if (!forward && !back && key !== 'Home' && key !== 'End') return
    if (!opts.active() || pageLocked(e.target)) return
    // Space on a button or link presses it.
    if (key === ' ' && e.target instanceof HTMLElement && e.target.closest('button, a, summary, [role="button"]')) return
    e.preventDefault()
    if (gliding || e.repeat) return
    if (key === 'Home') glideTo(0)
    else if (key === 'End') glideTo(opts.rests().length - 1)
    else step(forward ? 1 : -1)
  }

  // Native scrolling (scrollbar, touch, find-in-page) comes to rest too.
  function onScrollIdle(): void {
    if (gliding) return
    clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      if (!gliding) settle(nearestRest(opts.rests(), window.scrollY))
    }, 140)
  }

  function start(): void {
    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScrollIdle, { passive: true })
    settle(nearestRest(opts.rests(), window.scrollY))
  }
  function stop(): void {
    window.removeEventListener('wheel', onWheel)
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('scroll', onScrollIdle)
    cancelAnimationFrame(raf)
    clearTimeout(settleTimer)
    if (gliding) snapping(true)
    gliding = false
  }
  /** Glide to rest `index` (the scenes' "next" buttons); no-op while a glide runs. */
  function goTo(index: number): void {
    if (gliding) return
    glideTo(index)
  }
  return { start, stop, goTo }
}
