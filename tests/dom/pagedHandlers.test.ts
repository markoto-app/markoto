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
  if (typeof onOverflow !== 'function' || typeof renderNode !== 'function') throw new Error('hooks missing')
  return {
    onOverflow: (o, r) => Reflect.apply(onOverflow, instance, [o, r]),
    renderNode: (c, s) => Reflect.apply(renderNode, instance, [c, s])
  }
}

function el(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
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

  it('never carries a single last row over on its own', () => {
    const rows = Array.from({ length: 6 }, (_, i) => `<tr data-ref="r${i}"><td>${i}</td></tr>`).join('')
    const source = el(`<table><tbody>${rows}</tbody></table>`)
    const r = el(`<div class="paged-doc"><p>Intro.</p><table><thead><tr><th>H</th></tr></thead><tbody>${rows}</tbody></table></div>`)
    const h = handler(source)
    const last = r.querySelector('tr[data-ref="r5"]')
    const middle = r.querySelector('tr[data-ref="r3"]')
    if (!last || !middle) throw new Error('fixture')
    expect(refOf(startNode(h.onOverflow(overflowFrom(last, r), r)))).toBe('r4')
    // Two or more rows to carry: break where paged.js wanted to.
    expect(refOf(startNode(h.onOverflow(overflowFrom(middle, r), r)))).toBe('r3')
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
})
