import type Lenis from 'lenis'

/**
 * Lenis (https://github.com/darkroomengineering/lenis) for the product
 * tour's scrolling (`useTourScroll`): loaded with a dynamic import after
 * `load` + idle, created only while the pinned layout is active and
 * destroyed when a resize leaves it.
 */

/** Elements whose wheel/touch input is never smoothed: they scroll themselves. */
export const LENIS_PREVENT = '[role="dialog"], [role="menu"], [role="listbox"], textarea, select, [contenteditable="true"]'

/** A modal's scroll lock is on: the page itself isn't scrollable right now. */
export function pageLocked(): boolean {
  return getComputedStyle(document.body).overflowY === 'hidden' || getComputedStyle(document.documentElement).overflowY === 'hidden'
}

function afterLoadIdle(fn: () => void): () => void {
  let cancelled = false
  let idle: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const run = (): void => {
    if (cancelled) return
    if (typeof globalThis.requestIdleCallback === 'function') idle = globalThis.requestIdleCallback(fn, { timeout: 2000 })
    else timer = setTimeout(fn, 200)
  }
  if (document.readyState === 'complete') run()
  else window.addEventListener('load', run, { once: true })
  return () => {
    cancelled = true
    window.removeEventListener('load', run)
    if (idle !== null && typeof globalThis.cancelIdleCallback === 'function') globalThis.cancelIdleCallback(idle)
    if (timer !== null) clearTimeout(timer)
  }
}

export function createTourLenis(opts: {
  /** Whether the smooth scroll is wanted right now (the pinned desktop layout). */
  active: () => boolean
  /** The tour scroll is running (a late import after `stop()` creates nothing). */
  started: () => boolean
  onWheel: (e: { deltaY: number }) => void
  onDestroyed: () => void
}) {
  let lenis: Lenis | null = null
  let LenisClass: typeof Lenis | null = null
  let cancelLoad: (() => void) | null = null

  function create(): void {
    if (lenis || !LenisClass || !opts.active()) return
    lenis = new LenisClass({
      autoRaf: true,
      anchors: false,
      prevent: node => node.matches(LENIS_PREVENT),
      // A modal's scroll lock: leave the wheel to the browser.
      virtualScroll: () => !pageLocked()
    })
    lenis.on('virtual-scroll', opts.onWheel)
  }
  function destroy(): void {
    if (!lenis) return
    lenis.off('virtual-scroll', opts.onWheel)
    lenis.destroy()
    lenis = null
    opts.onDestroyed()
  }
  function load(): void {
    if (cancelLoad || LenisClass) return
    cancelLoad = afterLoadIdle(() => {
      import('lenis').then((mod) => {
        if (!opts.started()) return
        LenisClass = mod.default
        create()
      }).catch(() => {
        // Native scrolling with CSS proximity snapping stays in place.
      })
    })
  }
  function onMediaChange(): void {
    if (opts.active()) {
      if (LenisClass) create()
      else load()
    } else {
      destroy()
    }
  }
  function cancelLoading(): void {
    cancelLoad?.()
    cancelLoad = null
  }

  return { current: (): Lenis | null => lenis, load, onMediaChange, cancelLoading, destroy }
}
