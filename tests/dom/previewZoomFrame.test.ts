import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PREVIEW_ZOOM_SCRIPT } from '../../app/utils/preview/previewZoomFrame'
import type { PreviewZoomEngine } from '../../app/utils/preview/previewZoomFrame'

// The zoom engine reaches the preview iframe as the STRINGIFIED function
// (inlined into the opaque-origin bootstrap), so this suite evaluates
// exactly that string. happy-dom has no layout: page and pane widths are
// stubbed; the real pull-back animation + scroll anchoring are covered by
// the flow test (tests/e2e/flows/zoom-the-preview.spec.ts).

type Install = (toParent: (msg: Record<string, unknown>) => void) => PreviewZoomEngine

function loadEngine(): Install {
  const fn: unknown = new Function(`return (${PREVIEW_ZOOM_SCRIPT})`)()
  if (typeof fn !== 'function') throw new Error('zoom script did not evaluate to a function')
  return (toParent) => {
    const engine: unknown = Reflect.apply(fn, undefined, [toParent])
    if (typeof engine !== 'object' || engine === null) throw new Error('no engine')
    const set: unknown = Reflect.get(engine, 'set')
    const reapply: unknown = Reflect.get(engine, 'reapply')
    const overviewGrid: unknown = Reflect.get(engine, 'overviewGrid')
    if (typeof set !== 'function' || typeof reapply !== 'function' || typeof overviewGrid !== 'function') throw new Error('engine API missing')
    return {
      set: cmd => Reflect.apply(set, engine, [cmd]),
      reapply: r => Reflect.apply(reapply, engine, [r]),
      overviewGrid: (a, p, c) => Reflect.apply(overviewGrid, engine, [a, p, c])
    }
  }
}

function stubWidth(el: Element, prop: 'offsetWidth' | 'clientWidth', value: number) {
  Object.defineProperty(el, prop, { configurable: true, get: () => value })
}

/** #mount with `n` A4-wide pages in a pane `pane` px wide. */
function mountPages(n: number, pane: number): { pages: HTMLElement, list: HTMLElement[] } {
  document.body.innerHTML = '<div id="mount" class="paged-mount"><div class="pagedjs_pages"></div></div>'
  const mount = document.getElementById('mount')
  const pages = mount?.querySelector<HTMLElement>('.pagedjs_pages')
  if (!mount || !pages) throw new Error('mount missing')
  stubWidth(mount, 'clientWidth', pane)
  const list: HTMLElement[] = []
  for (let i = 0; i < n; i++) {
    const page = document.createElement('div')
    page.className = 'pagedjs_page'
    page.innerHTML = `<div class="pagedjs_area"><p>Page ${i + 1}</p></div>`
    stubWidth(page, 'offsetWidth', 794)
    pages.appendChild(page)
    list.push(page)
  }
  return { pages, list }
}

describe('preview zoom engine (inlined into the iframe)', () => {
  // One engine per window, as in the iframe (it installs document /
  // window listeners); every test starts back at fit width.
  let posted: Array<Record<string, unknown>> = []
  let engine: PreviewZoomEngine

  beforeAll(() => {
    engine = loadEngine()(msg => posted.push(msg))
  })

  beforeEach(() => {
    document.body.innerHTML = '<div id="mount"></div>'
    engine.set({ mode: 'fit', scale: 1, animate: false, page: 0 })
    posted = []
  })

  afterEach(() => {
    document.documentElement.className = ''
    document.body.innerHTML = ''
  })

  it('stays self-contained (no imports, no module references)', () => {
    expect(PREVIEW_ZOOM_SCRIPT.startsWith('function installPreviewZoom')).toBe(true)
    expect(PREVIEW_ZOOM_SCRIPT).not.toMatch(/\bimport\b|require\(|__vite|postMessage/)
  })

  it('fits the page to the pane by default and never enlarges it', () => {
    const { pages } = mountPages(3, 397)
    engine.reapply(true)
    expect(pages.style.getPropertyValue('--page-zoom')).toBe('0.5')
    expect(posted.at(-1)).toEqual({ type: 'zoom-state', mode: 'fit', scale: 0.5, fitScale: 0.5 })

    const wide = mountPages(3, 2000)
    engine.reapply(true)
    expect(wide.pages.style.getPropertyValue('--page-zoom')).toBe('1')
  })

  it('applies a fixed zoom and marks it for horizontal scrolling', () => {
    const { pages } = mountPages(2, 600)
    engine.set({ mode: 'scale', scale: 1.5, animate: false, page: 0 })
    expect(pages.style.getPropertyValue('--page-zoom')).toBe('1.5')
    expect(document.documentElement.classList.contains('zoom-scale')).toBe(true)
    expect(document.documentElement.classList.contains('zoom-overview')).toBe(false)
    expect(posted.at(-1)).toMatchObject({ type: 'zoom-state', mode: 'scale', scale: 1.5 })
  })

  it('lays the overview out as a grid of readable thumbnails filling the pane', () => {
    // The split-view pane of a 1280 px window (~590 px): four across,
    // like the product video; a 700 px pane fits five.
    const grid = engine.overviewGrid(700, 794, 12)
    expect(grid.cols).toBe(5)
    const thumb = 794 * grid.zoom
    expect(thumb).toBeGreaterThanOrEqual(120)
    expect(5 * thumb + 4 * 14).toBeLessThanOrEqual(700)
    expect(engine.overviewGrid(593, 794, 12).cols).toBe(4)
    // A 390 px phone (358 px of pane): three ~100 px thumbnails.
    const phone = engine.overviewGrid(358, 794, 12)
    expect(phone.cols).toBe(3)
    expect(794 * phone.zoom).toBeGreaterThanOrEqual(96)
    // A wide preview-only pane gets more columns, never smaller thumbnails.
    const wide = engine.overviewGrid(1200, 794, 40)
    expect(wide.cols).toBe(9)
    expect(794 * wide.zoom).toBeGreaterThanOrEqual(120)
    // Short documents: no more columns than pages, at most half size.
    const short = engine.overviewGrid(1200, 794, 2)
    expect(short.cols).toBe(2)
    expect(short.zoom).toBeLessThanOrEqual(0.5)

    const { pages } = mountPages(12, 700)
    engine.set({ mode: 'overview', scale: 1, animate: true, page: 0 })
    expect(document.documentElement.classList.contains('zoom-overview')).toBe(true)
    expect(Number(pages.style.getPropertyValue('--page-zoom'))).toBeCloseTo(grid.zoom, 5)
    // The on-screen gap stays constant (gap is set in zoomed units).
    expect(Number.parseFloat(pages.style.getPropertyValue('--overview-gap')) * grid.zoom).toBeCloseTo(14, 5)
  })

  it('remembers a zoom that arrives before the first pagination', () => {
    engine.set({ mode: 'overview', scale: 1, animate: false, page: 0 })
    expect(posted).toEqual([])
    const { pages } = mountPages(12, 600)
    engine.reapply(true)
    expect(document.documentElement.classList.contains('zoom-overview')).toBe(true)
    expect(Number(pages.style.getPropertyValue('--page-zoom'))).toBeLessThan(0.5)
  })

  it('asks the parent to open a page clicked in the overview', () => {
    const { list } = mountPages(6, 600)
    engine.set({ mode: 'overview', scale: 1, animate: false, page: 0 })
    posted = []
    const inner = list[3]?.querySelector('p')
    inner?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(posted).toEqual([{ type: 'zoom-request', action: 'page', page: 4 }])
  })

  it('leaves clicks alone outside the overview', () => {
    const { list } = mountPages(3, 600)
    engine.set({ mode: 'fit', scale: 1, animate: false, page: 0 })
    posted = []
    list[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(posted).toEqual([])
  })

  it('forwards Ctrl/Cmd + = / - / 0 as zoom requests', () => {
    mountPages(2, 600)
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
    const press = (key: string, code: string) => {
      const e = new KeyboardEvent('keydown', { key, code, ctrlKey: !isMac, metaKey: isMac, bubbles: true, cancelable: true })
      document.dispatchEvent(e)
      return e.defaultPrevented
    }
    expect(press('=', 'Equal')).toBe(true)
    expect(press('-', 'Minus')).toBe(true)
    expect(press('0', 'Digit0')).toBe(true)
    expect(posted.map(m => m.action)).toEqual(['in', 'out', 'reset'])
    posted = []
    // Without the modifier: not ours.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '=', code: 'Equal', bubbles: true }))
    expect(posted).toEqual([])
  })

  it('takes over Ctrl+wheel (trackpad pinch) and reports where the gesture ended', async () => {
    const { pages } = mountPages(3, 600)
    engine.reapply(true)
    posted = []
    const wheel = new WheelEvent('wheel', { deltaY: -50, ctrlKey: true, cancelable: true, bubbles: true, clientX: 300, clientY: 300 })
    // happy-dom's WheelEvent drops the modifier keys from the init dict.
    Object.defineProperty(wheel, 'ctrlKey', { value: true })
    document.body.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(true)
    // A plain wheel scrolls as usual.
    const plain = new WheelEvent('wheel', { deltaY: -50, cancelable: true, bubbles: true })
    document.body.dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(false)
    await new Promise(r => setTimeout(r, 300))
    const gesture = posted.find(m => m.type === 'zoom-gesture')
    expect(gesture).toBeDefined()
    const scale = Number(gesture?.scale)
    expect(scale).toBeGreaterThan(Number(600 / 794))
    expect(Number(pages.style.getPropertyValue('--page-zoom'))).toBeCloseTo(scale, 5)
  })
})
