import { beforeAll, describe, expect, it, vi } from 'vitest'
import { PAGED_HANDLERS_SCRIPT, registerPagedHandlers } from '../../app/utils/preview/pagedHandlers'

// The handlers reach the live preview as the STRINGIFIED function (an
// inline script in the opaque-origin iframe), so this suite evaluates
// exactly that string against a minimal stand-in for the paged.js
// global. Layout-dependent bits (orphan line counting) need a real
// browser and are covered by the flow tests / render harness; the
// structural decisions are pinned here.

interface HandlerInstance {
  onOverflow: (overflow: Range | undefined, rendered: Element, bounds?: object, layout?: object) => Range | undefined
  renderNode: (clone: Node, source: Node) => void
  layout: (rendered: Element) => void
  afterParsed: (parsed: unknown) => void
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
  const afterParsed: unknown = Reflect.get(instance, 'afterParsed')
  if (typeof onOverflow !== 'function' || typeof renderNode !== 'function' || typeof layout !== 'function' || typeof afterParsed !== 'function') throw new Error('hooks missing')
  return {
    onOverflow: (o, r, b, l) => Reflect.apply(onOverflow, instance, [o, r, b, l]),
    renderNode: (c, s) => Reflect.apply(renderNode, instance, [c, s]),
    layout: r => Reflect.apply(layout, instance, [r]),
    afterParsed: p => Reflect.apply(afterParsed, instance, [p])
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

/** A DOMRectList stand-in (happy-dom has no range geometry). */
function rectList(rects: DOMRect[]): DOMRectList {
  return Object.assign({ length: rects.length, item: (i: number) => rects[i] ?? null, [Symbol.iterator]: () => rects[Symbol.iterator]() }, rects)
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

function startElement(range: Range | undefined): Element | null {
  const node = startNode(range)
  return node instanceof Element ? node : null
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
    expect(startElement(handler().onOverflow(overflowFrom(table, r), r))?.className).toBe('table-caption')
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

  it('carries a closing totals block over with at least three rows before it', () => {
    const names = ['Research', 'Frontend', 'Backend', 'Management', 'Audit', 'Discount', '<strong>Subtotal</strong>', 'VAT 8.1 %', '<strong>Total</strong>']
    const rows = names.map((n, i) => `<tr data-ref="t${i}"><td>${n}</td><td>1</td></tr>`).join('')
    const source = el(`<table><tbody>${rows}</tbody></table>`)
    const r = el(`<div class="paged-doc"><p>Intro.</p><table><thead><tr><th>Item</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table></div>`)
    const vat = r.querySelector('tr[data-ref="t7"]')
    if (!vat) throw new Error('fixture')
    // paged.js would leave VAT + Total alone on the next page: the totals
    // (Subtotal · VAT · Total) and three rows before them go over.
    expect(refOf(startNode(handler(source).onOverflow(overflowFrom(vat, r), r)))).toBe('t3')
  })

  it('does not treat a column of bold row headers as totals', () => {
    const rows = Array.from({ length: 8 }, (_, i) => `<tr data-ref="b${i}"><td><strong>SEV-${i}</strong></td><td>x</td></tr>`).join('')
    const source = el(`<table><tbody>${rows}</tbody></table>`)
    const r = el(`<div class="paged-doc"><p>Intro.</p><table><tbody>${rows}</tbody></table></div>`)
    const row = r.querySelector('tr[data-ref="b5"]')
    if (!row) throw new Error('fixture')
    expect(refOf(startNode(handler(source).onOverflow(overflowFrom(row, r), r)))).toBe('b5')
  })

  it('moves the whole table when paged.js breaks at its body (header row left alone)', () => {
    const r = el('<div class="paged-doc"><p>Intro.</p><table><thead><tr><th>H</th></tr></thead><tbody><tr><td>1</td></tr><tr><td>2</td></tr></tbody></table></div>')
    const body = r.querySelector('tbody')
    if (!body) throw new Error('fixture')
    expect(startNode(handler().onOverflow(overflowFrom(body, r), r))?.nodeName).toBe('TABLE')
  })

  it('keeps at least three code lines on each side of a split', () => {
    const lines = (from: number, to: number): string => Array.from({ length: to - from + 1 }, (_, i) => `<span class="code-line" data-line="${from + i}">line ${from + i}</span>`).join('')
    const source = el(`<pre data-ref="c1"><code>${lines(1, 20)}</code></pre>`)
    const r = el(`<div class="paged-doc"><p>Intro.</p><pre data-ref="c1"><code>${lines(1, 20)}</code></pre></div>`)
    const h = handler(source)
    const last = r.querySelector('[data-line="20"]')
    const second = r.querySelector('[data-line="2"]')
    if (!last || !second) throw new Error('fixture')
    // One line (the closing brace) would go over: three go.
    expect(startElement(h.onOverflow(overflowFrom(last, r), r))?.getAttribute('data-line')).toBe('18')
    // Only one line would stay: the block moves whole.
    expect(startNode(h.onOverflow(overflowFrom(second, r), r))?.nodeName).toBe('PRE')
  })

  it('moves a list instead of leaving its first item alone at the foot of the page', () => {
    const items = Array.from({ length: 5 }, (_, i) => `<li data-ref="l${i}">Step ${i}</li>`).join('')
    const source = el(`<ol>${items}</ol>`)
    const r = el(`<div class="paged-doc"><p>Intro.</p><ol>${items}</ol></div>`)
    const list = r.querySelector('ol')
    const second = r.querySelector('li[data-ref="l1"]')
    if (!list || !second) throw new Error('fixture')
    place(r, [[0, 0, 600, 1000]])
    place(list, [[0, 900, 600, 100]])
    expect(startNode(handler(source).onOverflow(overflowFrom(second, r), r))?.nodeName).toBe('OL')
  })

  it('shrinks a diagram in small steps until it fits the rest of the page', () => {
    const r = el('<div class="pagedjs_page_content"><div class="paged-doc"><p data-ref="a">Text before.</p><div class="mermaid" data-ref="d"><img></div><p data-ref="b">Text after.</p></div></div>')
    const content = r.firstElementChild
    const [before, after] = Array.from(r.querySelectorAll('p'))
    const diagram = r.querySelector('.mermaid')
    if (!(content instanceof HTMLElement) || !before || !after || !(diagram instanceof HTMLElement)) throw new Error('fixture')
    place(content, [[0, 0, 600, 740]])
    place(before, [[0, 0, 600, 400]])
    place(diagram, [[0, 400, 600, 380]])
    Object.defineProperty(diagram, 'offsetHeight', { configurable: true, value: 380 })
    // 340px of room for 380px: the estimate (0.89) is not quite enough,
    // paged.js still finds the diagram overflowing until 0.83.
    const layout = {
      findOverflow: () => overflowFrom(Number.parseFloat(diagram.style.zoom) > 0.84 ? diagram : after, content)
    }
    const bounds = { left: 0, right: 600, top: 0, bottom: 740 }
    // The text before the diagram ends at 400px (happy-dom has no range geometry).
    const rects = vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(() => rectList([new DOMRect(0, 0, 600, 400)]))
    const result = handler().onOverflow(overflowFrom(diagram, content), content, bounds, layout)
    rects.mockRestore()
    expect(diagram.style.zoom).toBe('0.83')
    expect(diagram.hasAttribute('data-markoto-fit')).toBe(true)
    expect(refOf(startNode(result))).toBe('b')
  })

  it('moves a diagram whole when it would need less than 75 %', () => {
    const r = el('<div class="pagedjs_page_content"><div class="paged-doc"><p data-ref="a">Text before.</p><div class="mermaid" data-ref="d"><img></div></div></div>')
    const content = r.firstElementChild
    const before = r.querySelector('p')
    const diagram = r.querySelector('.mermaid')
    if (!(content instanceof HTMLElement) || !before || !(diagram instanceof HTMLElement)) throw new Error('fixture')
    place(content, [[0, 0, 600, 740]])
    place(before, [[0, 0, 600, 500]])
    place(diagram, [[0, 500, 600, 380]])
    Object.defineProperty(diagram, 'offsetHeight', { configurable: true, value: 380 })
    const layout = { findOverflow: () => overflowFrom(diagram, content) }
    const rects = vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(() => rectList([new DOMRect(0, 0, 600, 500)]))
    const result = handler().onOverflow(overflowFrom(diagram, content), content, { left: 0, right: 600, top: 0, bottom: 740 }, layout)
    rects.mockRestore()
    // 240px of room for 380px (0.63): it keeps its size and paged.js's break before it stands.
    expect(diagram.style.zoom).toBe('')
    expect(diagram.hasAttribute('data-markoto-fit')).toBe(false)
    expect(result).toBeUndefined()
  })

  it('gives a hidden node in a page the position of the content before it (not x = 0)', () => {
    const r = el('<div class="pagedjs_page"><div class="paged-doc"><p>Masthead.</p></div></div>')
    const doc = r.querySelector('.paged-doc')
    const p = r.querySelector('p')
    if (!doc || !p) throw new Error('fixture')
    place(p, [[-9000, 100, 600, 40]])
    const hr = document.createElement('hr')
    hr.style.display = 'none'
    const hidden = document.createElement('span')
    hidden.textContent = 'inside'
    hr.appendChild(hidden)
    doc.appendChild(hr)
    const rect = hr.getBoundingClientRect()
    expect(rect.left).toBe(-9000)
    expect(rect.top).toBe(140)
    // Inside a hidden node too.
    expect(hidden.getBoundingClientRect().top).toBe(140)
  })

  it('leaves the rect of a node outside the pages, or of a visible one, alone', () => {
    const outside = el('<hr style="display: none">').firstElementChild
    const visible = el('<div class="pagedjs_page"><p>Text.</p></div>').querySelector('p')
    if (!outside || !visible) throw new Error('fixture')
    expect(outside.getBoundingClientRect().left).toBe(0)
    expect(visible.getBoundingClientRect().top).toBe(0)
  })

  it('leaves column breaks alone in a single-column document', () => {
    const r = el('<div class="pagedjs_page_content"><div class="paged-doc"><p>Body text.</p><h2>Section</h2><p>Section text.</p></div></div>')
    handler().layout(r)
    expect(r.querySelector('[data-markoto-column-break]')).toBeNull()
  })
})

describe('multi-column: wide blocks and the columns before them', () => {
  /** Two 300px columns with a 20px gap on a 620 × 800 page. */
  function twoColumns(body: string): { r: HTMLElement, doc: HTMLElement } {
    const r = el(`<div class="pagedjs_page_content"><div class="paged-doc" style="column-count: 2; column-gap: 20px">${body}</div></div>`)
    const content = r.firstElementChild
    const doc = r.querySelector('.paged-doc')
    if (!(content instanceof HTMLElement) || !(doc instanceof HTMLElement)) throw new Error('fixture')
    place(content, [[0, 0, 620, 800]])
    place(doc, [[0, 0, 620, 800]])
    Object.defineProperty(doc, 'offsetWidth', { configurable: true, value: 620 })
    return { r, doc }
  }

  it('spans a table that fits its column only by breaking the code in its cells apart', () => {
    const { r } = twoColumns('<table><tr><td><code>FERRULE_INVALIDATION_FLUSH_INTERVAL_MS</code></td></tr></table><table><tr><td>short</td></tr></table><p>After.</p>')
    const [wide, narrow] = Array.from(r.querySelectorAll('table'))
    if (!wide || !narrow) throw new Error('fixture')
    // 300px with `overflow-wrap: anywhere`, 450px with nothing broken apart.
    Object.defineProperty(wide, 'offsetWidth', { configurable: true, get: () => wide.hasAttribute('data-markoto-measure') ? 450 : 300 })
    Object.defineProperty(narrow, 'offsetWidth', { configurable: true, get: () => 280 })
    handler().layout(r)
    expect(wide.style.getPropertyValue('column-span')).toBe('all')
    expect(wide.hasAttribute('data-markoto-wide')).toBe(true)
    expect(wide.hasAttribute('data-markoto-measure')).toBe(false)
    expect(narrow.style.getPropertyValue('column-span')).toBe('')
    // Measured once it is complete (something follows it on the page).
    expect(narrow.hasAttribute('data-markoto-measured')).toBe(true)
  })

  it('spans a table already wider than its column and a diagram drawn wider than it', () => {
    const { r } = twoColumns('<table><tr><td>cells</td></tr></table><div class="mermaid"><img></div><div class="mermaid"><img></div>')
    const table = r.querySelector('table')
    const [wide, fits] = Array.from(r.querySelectorAll('.mermaid'))
    if (!(table instanceof HTMLElement) || !(wide instanceof HTMLElement) || !(fits instanceof HTMLElement)) throw new Error('fixture')
    Object.defineProperty(table, 'offsetWidth', { configurable: true, value: 420 })
    Object.defineProperty(wide, 'offsetWidth', { configurable: true, value: 300 })
    Object.defineProperty(wide, 'scrollWidth', { configurable: true, value: 480 })
    Object.defineProperty(fits, 'offsetWidth', { configurable: true, value: 300 })
    Object.defineProperty(fits, 'scrollWidth', { configurable: true, value: 300 })
    handler().layout(r)
    expect(table.style.getPropertyValue('column-span')).toBe('all')
    expect(wide.style.getPropertyValue('column-span')).toBe('all')
    expect(fits.style.getPropertyValue('column-span')).toBe('')
  })

  it('keeps a heading with its text where Chromium balances the columns (before a spanning block)', () => {
    const { r } = twoColumns('<h2>Cache sizes</h2><p>The limits below apply per node:</p><p>Plain text.</p>')
    const h2 = r.querySelector('h2')
    const [lead, plain] = Array.from(r.querySelectorAll('p'))
    if (!(h2 instanceof HTMLElement) || !(lead instanceof HTMLElement) || !(plain instanceof HTMLElement)) throw new Error('fixture')
    Object.defineProperty(lead, 'offsetHeight', { configurable: true, value: 16 })
    handler().layout(r)
    expect(h2.style.getPropertyValue('break-after')).toBe('avoid')
    // A one-line lead-in ending in a colon keeps with what follows too.
    expect(lead.style.getPropertyValue('break-after')).toBe('avoid')
    expect(plain.style.getPropertyValue('break-after')).toBe('')
  })
})

describe('display math wider than the column', () => {
  /** A KaTeX display: one `.katex-base` per piece, as KaTeX splits it at its break points. */
  function display(pieces: string[]): string {
    const bases = pieces.map(p => `<span class="katex-base"><span class="katex-strut"></span>${p}</span>`).join('')
    return `<p class="katex-block"><span class="katex-display"><span class="katex"><span class="katex-html">${bases}</span></span></span></p>`
  }
  const rel = (op: string) => `<span class="mspace"></span><span class="mrel">${op}</span><span class="mspace"></span>`
  const bin = (op: string) => `<span class="mspace"></span><span class="mbin">${op}</span><span class="mspace"></span>`

  it('breaks before a relation or binary operator in display math, not after it', () => {
    const frag = document.createElement('div')
    frag.innerHTML = display([`<span class="mord">E</span>${rel('=')}`, `<span class="mord">a</span>${bin('+')}`, '<span class="mord">b</span>'])
      + '<span class="katex"><span class="katex-html"><span class="katex-base"><span class="katex-strut"></span><span class="mord">x</span><span class="mrel">=</span></span><span class="katex-base"><span class="katex-strut"></span><span class="mord">y</span></span></span></span>'
    handler().afterParsed(frag)
    const [first, second, third] = Array.from(frag.querySelectorAll('.katex-display .katex-base'))
    const kids = (e: Element | undefined) => Array.from(e?.children ?? []).map(c => c.className)
    expect(kids(first)).toEqual(['katex-strut', 'mord'])
    expect(kids(second)).toEqual(['katex-strut', 'mspace', 'mrel', 'mspace', 'mord'])
    expect(kids(third)).toEqual(['katex-strut', 'mspace', 'mbin', 'mspace', 'mord'])
    // Inline math keeps TeX's in-text rule (break after the relation).
    const inline = frag.querySelector(':scope > .katex .katex-base')
    expect(kids(inline ?? undefined)).toEqual(['katex-strut', 'mord', 'mrel'])
  })

  it('never empties a piece that holds only the operator', () => {
    const frag = document.createElement('div')
    frag.innerHTML = display([rel('='), '<span class="mord">b</span>'])
    handler().afterParsed(frag)
    const [first] = Array.from(frag.querySelectorAll('.katex-base'))
    expect(first?.querySelector('.mrel')).not.toBeNull()
  })

  function laidOut(pieces: string[], rects: Array<[number, number, number, number]>, width = 400): { r: HTMLElement, katex: HTMLElement, html: HTMLElement, displayEl: Element } {
    const r = el(`<div class="pagedjs_page_content"><div class="paged-doc">${display(pieces)}</div></div>`)
    const html = r.querySelector('.katex-html')
    const katex = r.querySelector('.katex')
    const displayEl = r.querySelector('.katex-display')
    if (!(html instanceof HTMLElement) || !(katex instanceof HTMLElement) || !displayEl) throw new Error('fixture')
    place(html, [[0, 0, width, 40]])
    Object.defineProperty(html, 'offsetWidth', { configurable: true, value: width })
    Array.from(r.querySelectorAll('.katex-base')).forEach((b, i) => place(b, [rects[i] ?? [0, 0, 0, 0]]))
    return { r, katex, html, displayEl }
  }

  it('shrinks a matrix wider than the column, to 85 % at most, and keeps it on one line', () => {
    const { r, katex, html, displayEl } = laidOut(['<span class="mord">M</span>', `${rel('=')}<span class="minner">(matrix)</span>`], [[0, 0, 20, 30], [20, 0, 600, 30]])
    handler().layout(r)
    expect(displayEl.getAttribute('data-markoto-math-scale')).toBe('0.85')
    expect(katex.style.getPropertyValue('font-size')).toBe('0.85em')
    // Still too wide (in one column): it stays together and runs into the margin.
    expect(html.style.getPropertyValue('white-space')).toBe('nowrap')
  })

  it('shrinks the whole formula onto one line when that is enough', () => {
    const { r, displayEl } = laidOut(['<span class="mord">s</span>', `${rel('=')}<span class="mfrac">(fraction)</span>`], [[0, 0, 20, 30], [20, 0, 420, 30]])
    handler().layout(r)
    // 400 / 440 → 0.9 for the whole line (not 0.95 for the fraction alone, which would strand "s").
    expect(displayEl.getAttribute('data-markoto-math-scale')).toBe('0.9')
  })

  it('aligns the continuation lines of a wrapped display at the first relation, as a centred block', () => {
    // E[T] | = Σ… | = n H_n   / (next line) = n ln n
    const { r, html, displayEl } = laidOut(
      ['<span class="mord">E[T]</span>', `${rel('=')}<span class="mord">sum</span>`, `${rel('=')}<span class="mord">nH</span>`, `${rel('=')}<span class="mord">n ln n</span>`],
      [[0, 0, 100, 30], [100, 0, 150, 30], [250, 0, 140, 30], [100, 30, 80, 30]]
    )
    handler().layout(r)
    expect(displayEl.hasAttribute('data-markoto-math-wrapped')).toBe(true)
    expect(html.style.getPropertyValue('text-align')).toBe('left')
    // Hanging indent = where the first relation starts (100px); the widest
    // line reaches 390px of 400, so the block moves 5px right to centre it.
    expect(html.style.getPropertyValue('text-indent')).toBe('-100px')
    expect(html.style.getPropertyValue('padding-left')).toBe('105px')
  })

  it('leaves a display that fits alone', () => {
    const { r, html, displayEl } = laidOut(['<span class="mord">E</span>', `${rel('=')}<span class="mord">mc²</span>`], [[150, 0, 20, 30], [170, 0, 80, 30]])
    handler().layout(r)
    expect(displayEl.hasAttribute('data-markoto-math-scale')).toBe(false)
    expect(html.getAttribute('style')).toBeNull()
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

describe('selectors paged.js rewrites keep their specificity', () => {
  class FakeFollowing {
    styleSheet = new CSSStyleSheet()
    processSelectors(_parsed: ParentNode, _selectors: Record<string, [string, string]>): void {
      throw new Error('paged.js original must be replaced')
    }
  }

  beforeAll(() => {
    const paged = { Handler: FakeHandler, registerHandlers: () => {}, registeredHandlers: [FakeFollowing] }
    new Function('Paged', PAGED_HANDLERS_SCRIPT.replace('globalThis.Paged', 'Paged'))(paged)
  })

  it('marks the elements and inserts the rule with the original selector inside :is()', () => {
    const parsed = el('<div class="paged-doc"><h1>T</h1><p>Lead.</p><p>Body.</p></div>')
    const handlerInstance = new FakeFollowing()
    const id = 'following-0f8fad5b-d9cb-469f-a165-70867728950e'
    handlerInstance.processSelectors.call(handlerInstance, parsed, { '.paged-doc h1 + p': [id, 'font-size: 1.1em'] })
    const lead = parsed.querySelectorAll('p')[0]
    expect(lead?.getAttribute('data-following')).toBe(id)
    expect(parsed.querySelectorAll('p')[1]?.hasAttribute('data-following')).toBe(false)
    const rule = handlerInstance.styleSheet.cssRules[0]?.cssText ?? ''
    expect(rule).toContain(':is(.paged-doc h1 + p')
    expect(rule).toContain('data-following')
    expect(rule).toContain('font-size: 1.1em')
  })

  it('keeps a pseudo-element outside :is() and uses the handler\'s own attribute', () => {
    const parsed = el('<ul><li>a</li><li>b</li></ul>')
    const handlerInstance = new FakeFollowing()
    const id = 'nth-of-type-0f8fad5b-d9cb-469f-a165-70867728950e'
    handlerInstance.processSelectors.call(handlerInstance, parsed, { 'li:first-of-type::marker': [id, 'color: red'] })
    expect(parsed.querySelector('li')?.getAttribute('data-nth-of-type')).toBe(id)
    const rule = handlerInstance.styleSheet.cssRules[0]?.cssText ?? ''
    expect(rule).toMatch(/:is\(li:first-of-type, :where\(\[data-nth-of-type\*=.*\)\)::marker/)
  })
})

// The server render page registers the same parts directly (no string):
// the two paths must wire them alike.
describe('direct registration (server render page)', () => {
  const direct: unknown[] = []

  beforeAll(() => {
    const paged = { Handler: FakeHandler, registerHandlers: (...h: unknown[]) => direct.push(...h) }
    registerPagedHandlers(paged)
    registerPagedHandlers(paged)
  })

  it('registers one handler that applies the same break rules', () => {
    expect(direct).toHaveLength(1)
    const H = direct[0]
    if (typeof H !== 'function') throw new Error('no handler registered')
    const instance: unknown = Reflect.construct(H, [{ source: undefined }, null, null])
    const onOverflow: unknown = typeof instance === 'object' && instance !== null ? Reflect.get(instance, 'onOverflow') : null
    if (typeof onOverflow !== 'function') throw new Error('onOverflow missing')
    const r = el('<div class="paged-doc"><p>Intro text.</p><h1>Section</h1><table><tbody><tr><td>1</td></tr></tbody></table></div>')
    const table = r.querySelector('table')
    if (!table) throw new Error('fixture')
    const out: unknown = Reflect.apply(onOverflow, instance, [overflowFrom(table, r), r])
    expect(out instanceof Range ? startNode(out)?.nodeName : null).toBe('H1')
  })
})
