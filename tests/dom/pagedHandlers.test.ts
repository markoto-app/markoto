import { beforeAll, describe, expect, it } from 'vitest'
import { PAGED_HANDLERS_SCRIPT } from '../../app/utils/pagedHandlers'

// The handlers reach the live preview as the STRINGIFIED function (an
// inline script in the opaque-origin iframe), so this suite evaluates
// exactly that string against a minimal stand-in for the paged.js
// global. Layout-dependent bits (orphan line counting) need a real
// browser and are covered by the flow tests / render harness; the
// structural decisions are pinned here.

interface HandlerInstance {
  onOverflow: (overflow: Range | undefined, rendered: Element) => Range | undefined
  renderNode: (clone: Node, source: Node) => void
  layout: (rendered: Element) => void
}

const registered: unknown[] = []

class FakeHandler {
  chunker: unknown
  constructor(chunker: unknown) {
    this.chunker = chunker
  }
}

function handler(source?: Element): HandlerInstance {
  const H = registered[0]
  if (typeof H !== 'function') throw new Error('no handler registered')
  const instance: unknown = Reflect.construct(H, [{ source }, null, null])
  if (typeof instance !== 'object' || instance === null) throw new Error('bad handler')
  const onOverflow: unknown = Reflect.get(instance, 'onOverflow')
  const renderNode: unknown = Reflect.get(instance, 'renderNode')
  const layout: unknown = Reflect.get(instance, 'layout')
  if (typeof onOverflow !== 'function' || typeof renderNode !== 'function' || typeof layout !== 'function') throw new Error('hooks missing')
  return {
    onOverflow: (o, r) => Reflect.apply(onOverflow, instance, [o, r]),
    renderNode: (c, s) => Reflect.apply(renderNode, instance, [c, s]),
    layout: r => Reflect.apply(layout, instance, [r])
  }
}

function el(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

/** Pin an element's layout boxes (happy-dom has no layout). */
function place(node: Element, rects: Array<[number, number, number, number]>): void {
  const list = rects.map(([x, y, w, h]) => new DOMRect(x, y, w, h))
  Object.defineProperty(node, 'getClientRects', { configurable: true, value: () => list })
  const first = list[0] ?? new DOMRect()
  Object.defineProperty(node, 'getBoundingClientRect', { configurable: true, value: () => first })
}

function overflowFrom(node: Node, rendered: Element): Range {
  const r = document.createRange()
  r.setStartBefore(node)
  r.setEndAfter(rendered.lastChild ?? rendered)
  return r
}

function startNode(range: Range | undefined): Node | null {
  if (!range) return null
  return range.startContainer.childNodes[range.startOffset] ?? null
}

function refOf(node: Node | null): string | null {
  return node instanceof Element ? node.getAttribute('data-ref') : null
}

beforeAll(() => {
  Reflect.set(globalThis, 'Paged', { Handler: FakeHandler, registerHandlers: (...h: unknown[]) => registered.push(...h) })
  // Exactly what the iframe runs.
  new Function(PAGED_HANDLERS_SCRIPT)()
  // A second copy (the server page + a re-injected script) must not double-register.
  new Function(PAGED_HANDLERS_SCRIPT)()
})

describe('pagination handlers (stringified, as the preview iframe runs them)', () => {
  it('registers exactly one handler', () => {
    expect(registered).toHaveLength(1)
  })

  it('keeps a heading with the block that moved to the next page', () => {
    const r = el('<div class="paged-doc"><p>Intro text.</p><h1>Section</h1><h2>Sub</h2><table><tbody><tr><td>1</td></tr></tbody></table></div>')
    const table = r.querySelector('table')
    if (!table) throw new Error('fixture')
    const out = handler().onOverflow(overflowFrom(table, r), r)
    expect(startNode(out)?.nodeName).toBe('H1')
  })

  it('leaves a heading alone when it is already the first thing on the page', () => {
    const r = el('<div class="paged-doc"><h2>Sub</h2><p>Body.</p></div>')
    const p = r.querySelector('p')
    if (!p) throw new Error('fixture')
    expect(handler().onOverflow(overflowFrom(p, r), r)).toBeUndefined()
  })

  it('moves the whole table when only its header row would stay behind', () => {
    const r = el('<div class="paged-doc"><p>Intro.</p><table><thead><tr><th>H</th></tr></thead><tbody><tr><td>1</td></tr><tr><td>2</td></tr></tbody></table></div>')
    const firstRow = r.querySelector('tbody tr')
    if (!firstRow) throw new Error('fixture')
    expect(startNode(handler().onOverflow(overflowFrom(firstRow, r), r))?.nodeName).toBe('TABLE')
  })

  it('keeps at least three body rows on each side of a split', () => {
    const rows = Array.from({ length: 6 }, (_, i) => `<tr data-ref="r${i}"><td>${i}</td></tr>`).join('')
    const source = el(`<table><tbody>${rows}</tbody></table>`)
    const r = el(`<div class="paged-doc"><p>Intro.</p><table><thead><tr><th>H</th></tr></thead><tbody>${rows}</tbody></table></div>`)
    const h = handler(source)
    const last = r.querySelector('tr[data-ref="r5"]')
    const middle = r.querySelector('tr[data-ref="r3"]')
    if (!last || !middle) throw new Error('fixture')
    expect(refOf(startNode(h.onOverflow(overflowFrom(last, r), r)))).toBe('r3')
    // Three rows to carry and three staying: break where paged.js wanted to.
    expect(refOf(startNode(h.onOverflow(overflowFrom(middle, r), r)))).toBe('r3')
    // Only one row would stay behind: the whole table moves.
    const second = r.querySelector('tr[data-ref="r1"]')
    if (!second) throw new Error('fixture')
    expect(startNode(h.onOverflow(overflowFrom(second, r), r))?.nodeName).toBe('TABLE')
  })

  it('repeats the header row on a table continued from the previous page', () => {
    const source = el('<table><thead><tr data-ref="h0"><th data-ref="h1">Head</th></tr></thead><tbody><tr data-ref="b0"><td>1</td></tr></tbody></table>')
    const r = el('<table data-split-from="t"><tbody data-split-from="tb"><tr data-ref="b0"><td>1</td></tr></tbody></table>')
    const clone = r.querySelector('tr')
    const original = source.querySelector('tbody tr')
    if (!clone || !original) throw new Error('fixture')
    const h = handler(source)
    h.renderNode(clone, original)
    h.renderNode(clone, original)
    const heads = r.querySelectorAll('table > thead')
    expect(heads).toHaveLength(1)
    expect(heads[0]?.className).toBe('markoto-repeated-thead')
    expect(heads[0]?.textContent).toBe('Head')
    expect(heads[0]?.querySelector('[data-ref]')).toBeNull()
    expect(r.querySelector('table')?.firstElementChild?.nodeName).toBe('THEAD')
  })

  it('does not touch tables that start on this page', () => {
    const source = el('<table><thead><tr><th>Head</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>')
    const r = el('<table><tbody><tr><td>1</td></tr></tbody></table>')
    const clone = r.querySelector('tr')
    const original = source.querySelector('tbody tr')
    if (!clone || !original) throw new Error('fixture')
    handler(source).renderNode(clone, original)
    expect(r.querySelector('thead')).toBeNull()
  })

  it('keeps a definition term with its description', () => {
    const r = el('<div class="paged-doc"><p>Intro.</p><dl><dt>Effective budget</dt><dd>What is left after the reserve.</dd></dl></div>')
    const dd = r.querySelector('dd')
    if (!dd) throw new Error('fixture')
    expect(startNode(handler().onOverflow(overflowFrom(dd, r), r))?.nodeName).toBe('DT')
  })

  it('keeps a table caption set above the table with it', () => {
    const r = el('<div class="paged-doc"><p>Intro.</p><p class="table-caption">Fitted coefficients</p><table><tbody><tr><td>1</td></tr></tbody></table></div>')
    const table = r.querySelector('table')
    if (!table) throw new Error('fixture')
    expect(startNode(handler().onOverflow(overflowFrom(table, r), r))?.className).toBe('table-caption')
  })

  it('keeps a third of a short table on each side when it splits only to fill the page', () => {
    const rows = Array.from({ length: 10 }, (_, i) => `<tr data-ref="s${i}"><td>${i}</td></tr>`).join('')
    const source = el(`<table><tbody>${rows}</tbody></table>`)
    const r = el(`<div class="paged-doc"><p>Intro.</p><table data-markoto-split><tbody>${rows}</tbody></table></div>`)
    const row7 = r.querySelector('tr[data-ref="s7"]')
    if (!row7) throw new Error('fixture')
    // Three rows would go over; a third of ten is four: one more goes along.
    expect(refOf(startNode(handler(source).onOverflow(overflowFrom(row7, r), r)))).toBe('s6')
    // An ordinary split keeps paged.js's row (three on each side is enough).
    r.querySelector('table')?.removeAttribute('data-markoto-split')
    expect(refOf(startNode(handler(source).onOverflow(overflowFrom(row7, r), r)))).toBe('s7')
  })

  it('starts a heading that ends a column at the top of the next column', () => {
    // Two 300px columns with a 20px gap on a 620 × 800 page.
    const r = el('<div class="pagedjs_page_content"><div class="paged-doc" style="column-count: 2; column-gap: 20px"><p>Body text.</p><h2>Section</h2><p>Section text.</p></div></div>')
    const content = r.firstElementChild
    const doc = r.querySelector('.paged-doc')
    const [before, h2, after] = Array.from(r.querySelectorAll('.paged-doc > *'))
    if (!(content instanceof HTMLElement) || !(doc instanceof HTMLElement) || !before || !h2 || !after) throw new Error('fixture')
    place(content, [[0, 0, 620, 800]])
    place(doc, [[0, 0, 620, 800]])
    Object.defineProperty(doc, 'offsetWidth', { configurable: true, value: 620 })
    place(before, [[0, 0, 300, 770]])
    place(h2, [[0, 770, 300, 20]])
    place(after, [[320, 0, 300, 60]])
    handler().layout(r)
    expect(h2.getAttribute('data-markoto-column-break')).toBe('')
    expect(h2 instanceof HTMLElement ? h2.style.getPropertyValue('break-before') : '').toBe('column')
  })

  it('leaves column breaks alone in a single-column document', () => {
    const r = el('<div class="pagedjs_page_content"><div class="paged-doc"><p>Body text.</p><h2>Section</h2><p>Section text.</p></div></div>')
    handler().layout(r)
    expect(r.querySelector('[data-markoto-column-break]')).toBeNull()
  })
})

describe('footnotes in multi-column pages', () => {
  const calls: unknown[][] = []
  class FakeFootnotes {
    needsLayout: unknown[] = []
    moveFootnote(...args: unknown[]): void {
      calls.push(args)
      const [node, , needsNoteCall] = args
      // paged.js's "no room for the note area" branch: defer to the next page.
      if (needsNoteCall === true && node instanceof Element) {
        const wrapper = document.createElement('div')
        wrapper.appendChild(node)
        this.needsLayout.push(wrapper)
      }
    }
  }

  function pageArea(columns: number): { area: HTMLElement, inner: HTMLElement, note: HTMLElement } {
    const area = el(`<div class="pagedjs_area"><div class="pagedjs_page_content"><div class="paged-doc" style="column-count: ${columns}"><p>Text<a data-footnote-call="n1">1</a></p></div></div><div class="pagedjs_footnote_area"><div class="pagedjs_footnote_content pagedjs_footnote_empty"><div class="pagedjs_footnote_inner_content"></div></div></div></div>`)
    const content = area.querySelector('.pagedjs_page_content')
    const call = area.querySelector('[data-footnote-call]')
    const inner = area.querySelector('.pagedjs_footnote_inner_content')
    if (!(content instanceof HTMLElement) || !call || !(inner instanceof HTMLElement)) throw new Error('fixture')
    place(content, [[0, 0, 600, 800]])
    place(call, [[100, 700, 10, 12]])
    place(area, [[0, 0, 600, 900]])
    const note = document.createElement('span')
    note.dataset.ref = 'n1'
    note.textContent = 'A footnote.'
    return { area, inner, note }
  }

  beforeAll(() => {
    const paged = { Handler: FakeHandler, registerHandlers: () => {}, registeredHandlers: [FakeFootnotes] }
    new Function('Paged', PAGED_HANDLERS_SCRIPT.replace('globalThis.Paged', 'Paged'))(paged)
  })

  it('keeps a note on its call\'s page when the call only moves to the next column', () => {
    const { area, inner, note } = pageArea(2)
    const footnotes = new FakeFootnotes()
    footnotes.moveFootnote(note, area, true)
    expect(calls.length).toBeGreaterThan(0)
    expect(note.parentElement).toBe(inner)
    expect(footnotes.needsLayout).toHaveLength(0)
    expect(note.id).toBe('note-n1')
    expect(area.style.getPropertyValue('--pagedjs-footnotes-height')).not.toBe('')
  })

  it('leaves paged.js\'s placement alone in a single-column page', () => {
    const { area, inner, note } = pageArea(1)
    const footnotes = new FakeFootnotes()
    footnotes.moveFootnote(note, area, true)
    expect(note.parentElement).not.toBe(inner)
    expect(footnotes.needsLayout).toHaveLength(1)
  })
})
