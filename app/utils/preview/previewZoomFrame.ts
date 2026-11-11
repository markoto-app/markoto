/**
 * Zoom engine of the live-preview iframe: fit width, a fixed factor, the
 * "All pages" overview grid, the animated pull-back / push-in between
 * them, Ctrl/Cmd +/-/0, Ctrl+wheel / trackpad pinch and touch pinch.
 *
 * The parent owns the user's setting (`usePreviewZoom`, persisted per
 * browser); this engine applies it to the paged.js pages and reports
 * back over the typed postMessage protocol (`previewFrame.ts`):
 *
 *   parent → iframe  {type:'zoom', mode, scale, animate, page}
 *   iframe → parent  {type:'zoom-state', mode, scale, fitScale}
 *                    {type:'zoom-request', action, page}
 *                    {type:'zoom-gesture', scale}
 *
 * Zoom is presentation only. It sets CSS `zoom` on `.pagedjs_pages` (not
 * `transform: scale`, which keeps the full-size layout box) and a class on
 * <html>; it never re-paginates. The print path reuses the bootstrap but
 * never sends a zoom message, and its `@media print` block resets zoom.
 *
 * DELIVERY. Like `pagedHandlers.ts`, the function below must stay
 * SELF-CONTAINED (no imports, no module references): the opaque-origin
 * iframe can't load app scripts, so `buildPreviewSrcdoc` inlines its
 * source (`PREVIEW_ZOOM_SCRIPT`) into the nonce'd bootstrap script.
 * `tests/dom/previewZoomFrame.test.ts` evaluates that string.
 */

export type FrameZoomMode = 'fit' | 'scale' | 'overview'

export interface FrameZoomCommand {
  mode: FrameZoomMode
  scale: number
  /** Animate the change (pull-back / push-in); reduced motion overrides. */
  animate: boolean
  /** 1-based page to bring to the top of the view; 0 keeps the reading position. */
  page: number
}

export interface PreviewZoomEngine {
  set: (cmd: FrameZoomCommand) => void
  /** Re-apply the current zoom after a render (`remeasure`) or resize. */
  reapply: (remeasure: boolean) => void
  /** Columns + zoom of the overview grid for a pane / page width (exposed for tests). */
  overviewGrid: (available: number, pageWidth: number, pageCount: number) => { cols: number, zoom: number }
}

function installPreviewZoom(toParent: (msg: Record<string, unknown>) => void): PreviewZoomEngine {
  /** Free-zoom range — keep in sync with PREVIEW_ZOOM_MIN / MAX (previewZoom.ts). */
  const MIN = 0.3
  const MAX = 3
  /**
   * Smallest overview thumbnail (CSS px on screen) and the gap between
   * them (about the size of the product video's grid). Narrow panes
   * (phones) go down to ~100 px so three fit across.
   */
  const THUMB_MAX_MIN = 120
  const THUMB_FLOOR = 96
  const GAP = 14
  /** Overview thumbnails never grow past half size (short documents). */
  const OVERVIEW_MAX = 0.5
  const DURATION_OVERVIEW = 520
  const DURATION_STEP = 200
  const EASING = 'cubic-bezier(0.22, 0.61, 0.36, 1)'
  /** Pinching in this far on the overview opens the page under the fingers. */
  const OVERVIEW_OPEN_FACTOR = 1.25

  const root = document.documentElement
  let mode: FrameZoomMode = 'fit'
  let fixedScale = 1
  let pageWidth = 0
  let current = 1
  let fitScale = 1
  let animation: Animation | null = null

  interface Anchor { index: number, fx: number, fy: number, vx: number, vy: number, rect: DOMRect }

  function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v))
  }

  function mountEl(): HTMLElement | null {
    return document.getElementById('mount')
  }

  function pagesEl(): HTMLElement | null {
    return mountEl()?.querySelector<HTMLElement>('.pagedjs_pages') ?? null
  }

  function pageList(): HTMLElement[] {
    const mount = mountEl()
    return mount ? Array.from(mount.querySelectorAll<HTMLElement>('.pagedjs_page')) : []
  }

  function reducedMotion(): boolean {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  function overviewGrid(available: number, natural: number, count: number): { cols: number, zoom: number } {
    if (!(available > 0) || !(natural > 0)) return { cols: 1, zoom: 1 }
    const fit = Math.min(1, available / natural)
    const thumbMin = Math.min(THUMB_MAX_MIN, Math.max(THUMB_FLOOR, available / 3.4))
    let cols = Math.max(1, Math.floor((available + GAP) / (thumbMin + GAP)))
    cols = Math.min(cols, Math.max(1, count))
    const zoom = Math.min((available - (cols - 1) * GAP) / (cols * natural), OVERVIEW_MAX, fit)
    // A hair under the exact fit so sub-pixel rounding never wraps a row early.
    return { cols, zoom: Math.max(0.02, zoom * 0.995) }
  }

  /** Lay the pages out for the current mode. False while there are no pages yet. */
  function applyLayout(remeasure: boolean): boolean {
    const pages = pagesEl()
    const first = pages?.querySelector<HTMLElement>('.pagedjs_page')
    const mount = mountEl()
    if (!pages || !first || !mount) return false
    if (remeasure || !pageWidth) {
      // Measure at zoom 1: the natural page width (A4 = 794px).
      pages.style.setProperty('--page-zoom', '1')
      pageWidth = first.offsetWidth
    }
    const available = mount.clientWidth
    if (!pageWidth || !available) return false
    fitScale = Math.min(1, available / pageWidth)
    root.classList.toggle('zoom-overview', mode === 'overview')
    root.classList.toggle('zoom-scale', mode === 'scale')
    let zoom = fitScale
    if (mode === 'overview') {
      zoom = overviewGrid(available, pageWidth, pageList().length).zoom
      pages.style.setProperty('--overview-gap', `${GAP / zoom}px`)
    } else if (mode === 'scale') {
      zoom = fixedScale
    }
    pages.style.setProperty('--page-zoom', String(zoom))
    current = zoom
    return true
  }

  function postState(): void {
    toParent({ type: 'zoom-state', mode, scale: current, fitScale })
  }

  /** The page under (or nearest to) a viewport point, and where in it the point is. */
  function anchorAt(point: { x: number, y: number } | null): Anchor | null {
    const list = pageList()
    if (list.length === 0) return null
    const vx = point ? point.x : window.innerWidth / 2
    const vy = point ? point.y : window.innerHeight / 2
    let best = 0
    let bestDistance = Infinity
    list.forEach((page, i) => {
      const r = page.getBoundingClientRect()
      const dx = vx < r.left ? r.left - vx : Math.max(0, vx - r.right)
      const dy = vy < r.top ? r.top - vy : Math.max(0, vy - r.bottom)
      const d = dx * dx + dy * dy
      if (d < bestDistance) {
        bestDistance = d
        best = i
      }
    })
    const page = list[best]
    if (!page) return null
    const rect = page.getBoundingClientRect()
    return {
      index: best,
      fx: rect.width ? clamp((vx - rect.left) / rect.width, 0, 1) : 0.5,
      fy: rect.height ? clamp((vy - rect.top) / rect.height, 0, 1) : 0,
      vx,
      vy,
      rect
    }
  }

  function anchorOnPage(index: number): Anchor | null {
    const page = pageList()[index]
    if (!page) return null
    const rect = page.getBoundingClientRect()
    return { index, fx: 0.5, fy: 0, vx: window.innerWidth / 2, vy: 40, rect }
  }

  /**
   * Scroll so the anchor is where the reader expects it:
   * 'point' — the same spot of the page under the same viewport point;
   * 'row'   — the page's overview row centred vertically;
   * 'top'   — the page's top edge just below the top of the view.
   */
  function restore(anchor: Anchor, target: 'point' | 'row' | 'top'): void {
    const page = pageList()[anchor.index]
    if (!page) return
    const r = page.getBoundingClientRect()
    if (target === 'row') {
      window.scrollTo(0, window.scrollY + r.top + r.height / 2 - window.innerHeight / 2)
    } else if (target === 'top') {
      window.scrollTo(window.scrollX + r.left + r.width / 2 - window.innerWidth / 2, window.scrollY + r.top - anchor.vy)
    } else {
      window.scrollTo(
        window.scrollX + r.left + anchor.fx * r.width - anchor.vx,
        window.scrollY + r.top + anchor.fy * r.height - anchor.vy
      )
    }
  }

  /**
   * Camera move: transform the whole mount so the anchor page sits where
   * it was before the change, then let it settle — a pull-back into the
   * grid, a push-in onto a page, or a short zoom around the anchor.
   */
  function animateFrom(anchor: Anchor, duration: number, fadeOthers: boolean): void {
    const mount = mountEl()
    const page = pageList()[anchor.index]
    if (!mount || !page || typeof mount.animate !== 'function') return
    const next = page.getBoundingClientRect()
    const box = mount.getBoundingClientRect()
    if (!next.width || !anchor.rect.width) return
    const s = anchor.rect.width / next.width
    const tx = anchor.rect.left - box.left - s * (next.left - box.left)
    const ty = anchor.rect.top - box.top - s * (next.top - box.top)
    if (Math.abs(s - 1) < 0.005 && Math.abs(tx) < 1 && Math.abs(ty) < 1) return
    root.classList.add('zoom-animating')
    mount.style.transformOrigin = '0 0'
    const run = mount.animate(
      [{ transform: `translate(${tx}px, ${ty}px) scale(${s})` }, { transform: 'none' }],
      { duration, easing: EASING }
    )
    animation = run
    // Into / out of the overview the layout changes around the anchor
    // page: let the other pages fade in instead of popping up.
    const fades = fadeOthers
      ? pageList().filter(p => p !== page).map(p => p.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: EASING }))
      : []
    const done = (): void => {
      if (animation !== run) return
      animation = null
      for (const fade of fades) fade.cancel()
      root.classList.remove('zoom-animating')
    }
    run.onfinish = done
    run.oncancel = done
  }

  function stopAnimation(): void {
    if (animation) animation.cancel()
  }

  function set(cmd: FrameZoomCommand): void {
    stopAnimation()
    const wasOverview = mode === 'overview'
    const anchor = cmd.page > 0 ? anchorOnPage(cmd.page - 1) : anchorAt(null)
    mode = cmd.mode
    fixedScale = clamp(cmd.scale, MIN, MAX)
    // No pages yet: stored, applied after the first pagination.
    if (!applyLayout(false)) return
    if (anchor) {
      restore(anchor, cmd.page > 0 ? 'top' : mode === 'overview' ? 'row' : 'point')
      if (cmd.animate && !reducedMotion()) {
        const switching = wasOverview !== (mode === 'overview')
        animateFrom(anchor, switching ? DURATION_OVERVIEW : DURATION_STEP, switching)
      }
    }
    postState()
  }

  function reapply(remeasure: boolean): void {
    if (applyLayout(remeasure)) postState()
  }

  // ─── Resize: keep the page you're reading in view ──────────────────
  let resizeFrame = 0
  window.addEventListener('resize', () => {
    if (resizeFrame) return
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0
      stopAnimation()
      const anchor = anchorAt(null)
      if (!applyLayout(false)) return
      if (anchor) restore(anchor, mode === 'overview' ? 'row' : 'point')
      postState()
    })
  })

  // ─── Keyboard: Ctrl/Cmd + = / - / 0 (same rule as zoomShortcutAction) ─
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
  document.addEventListener('keydown', (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey
    if (!mod || e.altKey) return
    let action = ''
    if (e.key === '=' || e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd') action = 'in'
    else if (e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract') action = 'out'
    else if (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0') action = 'reset'
    if (!action) return
    e.preventDefault()
    toParent({ type: 'zoom-request', action, page: 0 })
  }, true)

  // ─── Overview: click a page to open it at fit width ───────────────
  document.addEventListener('click', (e) => {
    if (mode !== 'overview') return
    const target = e.target
    const page = target instanceof Element ? target.closest('#mount .pagedjs_page') : null
    if (!page) return
    e.preventDefault()
    e.stopPropagation()
    toParent({ type: 'zoom-request', action: 'page', page: pageList().findIndex(p => p === page) + 1 })
  }, true)

  // ─── Gestures: Ctrl+wheel / trackpad pinch, touch pinch ───────────
  // Applied live inside the frame (one layout per animation frame); the
  // final factor goes to the parent, which stores it — or, pinched past
  // the minimum, switches to the overview.
  interface Gesture { base: number, factor: number, point: { x: number, y: number }, opened: boolean }
  let gesture: Gesture | null = null
  let gestureFrame = 0
  let gestureTimer: ReturnType<typeof setTimeout> | null = null

  function gestureStep(factor: number, point: { x: number, y: number }): void {
    if (!gesture) {
      stopAnimation()
      gesture = { base: current, factor: 1, point, opened: false }
    }
    gesture.factor *= factor
    gesture.point = point
    if (gestureFrame) return
    gestureFrame = requestAnimationFrame(() => {
      gestureFrame = 0
      const g = gesture
      if (!g) return
      if (mode === 'overview') {
        if (!g.opened && g.factor > OVERVIEW_OPEN_FACTOR) {
          g.opened = true
          const anchor = anchorAt(g.point)
          if (anchor) toParent({ type: 'zoom-request', action: 'page', page: anchor.index + 1 })
        }
        return
      }
      const zoom = clamp(g.base * g.factor, MIN, MAX)
      if (Math.abs(zoom - current) < 0.001) return
      const anchor = anchorAt(g.point)
      mode = 'scale'
      fixedScale = zoom
      if (applyLayout(false) && anchor) restore(anchor, 'point')
    })
  }

  function gestureEnd(): void {
    const g = gesture
    gesture = null
    if (!g) return
    if (mode !== 'overview' && !g.opened && Math.abs(g.factor - 1) > 0.001) {
      toParent({ type: 'zoom-gesture', scale: clamp(g.base * g.factor, 0.05, 10) })
    }
    postState()
  }

  document.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return
    e.preventDefault()
    const dy = clamp(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY, -60, 60)
    gestureStep(Math.exp(-dy * 0.01), { x: e.clientX, y: e.clientY })
    if (gestureTimer) clearTimeout(gestureTimer)
    gestureTimer = setTimeout(gestureEnd, 220)
  }, { passive: false })

  let pinch: { start: number, last: number } | null = null
  function spread(t: TouchList): number {
    const a = t[0]
    const b = t[1]
    return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0
  }
  function middle(t: TouchList): { x: number, y: number } {
    const a = t[0]
    const b = t[1]
    return a && b ? { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 } : { x: 0, y: 0 }
  }
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const d = spread(e.touches)
      pinch = d > 0 ? { start: d, last: 1 } : null
    }
  }, { passive: true })
  document.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return
    e.preventDefault()
    const f = spread(e.touches) / pinch.start
    if (!(f > 0)) return
    gestureStep(f / pinch.last, middle(e.touches))
    pinch.last = f
  }, { passive: false })
  const endPinch = (e: TouchEvent): void => {
    if (pinch && e.touches.length < 2) {
      pinch = null
      gestureEnd()
    }
  }
  document.addEventListener('touchend', endPinch)
  document.addEventListener('touchcancel', endPinch)
  // iOS Safari's own pinch gesture would zoom the whole app.
  document.addEventListener('gesturestart', (e) => {
    e.preventDefault()
  })

  return { set, reapply, overviewGrid }
}

/** Function source for the bootstrap (inlined by `buildPreviewSrcdoc`). */
export const PREVIEW_ZOOM_SCRIPT = installPreviewZoom.toString()
