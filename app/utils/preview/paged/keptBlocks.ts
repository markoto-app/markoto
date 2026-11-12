import type { BlockQueries, PageBox } from './blockQueries'
import type { LineGeometry } from './lineGeometry'

/**
 * Pagination handlers, part 6: blocks kept whole (`break-inside: avoid`)
 * that would leave a large gap when they jump to the next page.
 * SELF-CONTAINED like every part (see `blockQueries.ts`).
 *
 * KEPT-WHOLE BLOCKS vs PAGE-BOTTOM GAPS. Short code blocks (≤ 15 lines)
 * and short tables (≤ 12 rows) are `break-inside: avoid`, so Chromium
 * moves them whole to the next page. When that would leave a large empty
 * band at the bottom of this page, at least GAP_LINES body lines and
 * GAP_SHARE of the text height, counting the heading or lead-in that
 * would go along with the block, the block may split after all: at least
 * a third of it, and at least `minSplitLines` code lines / `minRows` table
 * rows, on each side. A table continued on the next page repeats its
 * header; a code block continues in a frame of its own. Otherwise it
 * still moves whole.
 *
 * DIAGRAMS SHRINK BEFORE THEY JUMP. A diagram (`.mermaid`, kept whole)
 * that doesn't fit the rest of the page would move to the next one and
 * leave a large gap. If it fits at MIN_DIAGRAM_SCALE of its size or more,
 * it is scaled down (CSS `zoom` on its box, which survives the img →
 * inline SVG swap after pagination) and the overflow is found again; if
 * it still doesn't fit, the scale is undone and it moves.
 */
export function createKeptBlocks(q: BlockQueries, geo: LineGeometry) {
  const GAP_LINES = 5
  const GAP_SHARE = 0.1
  const SOFT_KEEP = /^(PRE|TABLE)$/
  const MIN_DIAGRAM_SCALE = 0.75
  const DIAGRAM_SCALE_STEP = 0.03

  function isSoftKeep(el: Element): boolean {
    return SOFT_KEEP.test(el.nodeName) || el.classList.contains('code-block')
  }

  /** Let `block` (and the code / table inside it) break again; returns the undo. */
  function loosen(block: Element): () => void {
    const els = [block, ...Array.from(block.querySelectorAll('pre, table'))].filter(e => e instanceof HTMLElement)
    const before = els.map(e => e instanceof HTMLElement ? e.style.getPropertyValue('break-inside') : '')
    for (const e of els) if (e instanceof HTMLElement) e.style.setProperty('break-inside', 'auto')
    block.setAttribute('data-markoto-split', '')
    return () => {
      block.removeAttribute('data-markoto-split')
      els.forEach((e, i) => {
        if (!(e instanceof HTMLElement)) return
        const v = before[i]
        if (v) e.style.setProperty('break-inside', v)
        else e.style.removeProperty('break-inside')
      })
    }
  }

  /** The soft-kept block (short code / table) the overflow starts at, with content before it on the page. */
  function softKeptBlockAt(overflow: Range, rendered: Element): Element | null {
    const start = q.startElement(overflow, rendered)
    if (!start || start.midText) return null
    const block = q.outermostUnbreakable(start.el, rendered)
    return block && isSoftKeep(block) && q.hasContentBefore(block, rendered) ? block : null
  }

  /** Would moving `block` whole (with the heading / lead-in kept with it) leave a large gap? */
  function leavesLargeGap(block: Element, rendered: Element, page: PageBox): boolean {
    // The empty band this page would end with if the block moved whole.
    const content = rendered.closest('.pagedjs_page_content') ?? rendered
    const bottom = content.getBoundingClientRect().bottom
    // A heading / lead-in kept with the block would move along.
    let lead: Element = block
    for (let prev = q.prevElement(lead); prev && q.keepsWithNext(prev); prev = q.prevElement(prev)) lead = prev
    const end = geo.contentEndBefore(lead, rendered, page)
    if (end === null) return false
    const gap = bottom - end
    const lh = geo.linePx(rendered.querySelector('p') ?? block)
    return gap >= GAP_LINES * lh && gap >= GAP_SHARE * (page.bottom - page.top)
  }

  /** A split code block: at least `minSplitLines` lines on each side, else null (move it whole). */
  function codeSplit(block: Element, next: Range, page: PageBox): Range | null {
    const lines = Array.from(block.querySelectorAll('.code-line'))
    const here = lines.filter(l => Array.from(l.getClientRects()).some(r => r.height > 0 && geo.onPage(r, page))).length
    const least = Math.max(q.limits.minSplitLines, Math.ceil(lines.length / 3))
    const staying = Math.min(here, lines.length - least)
    const at = lines[staying]
    if (staying < least || !at) return null
    if (staying === here) return next
    const range = document.createRange()
    range.setStartBefore(at)
    range.setEnd(next.endContainer, next.endOffset)
    return range
  }

  function splitKeptBlock(overflow: Range, rendered: Element, page: PageBox, bounds: PageBox | undefined, layout: unknown): Range {
    const find = q.findOverflowOf(layout)
    if (!find || !bounds) return overflow
    const block = softKeptBlockAt(overflow, rendered)
    if (!block || !leavesLargeGap(block, rendered, page)) return overflow
    const undo = loosen(block)
    const next = find(rendered, bounds)
    if (!(next instanceof Range)) {
      undo()
      return overflow
    }
    // Tables: the row rules in adjustedBreak take it from here.
    if (block.nodeName === 'TABLE' || block.querySelector('table')) return next
    // Code: at least minSplitLines lines on each side, else move it whole.
    const split = codeSplit(block, next, page)
    if (split) return split
    undo()
    return overflow
  }

  /** The diagram the overflow starts at, when it could shrink (not yet scaled, content before it). */
  function diagramAt(overflow: Range, rendered: Element): HTMLElement | null {
    const { node, midText } = q.startOf(overflow)
    if (!node || midText) return null
    const el = node instanceof Element ? node : node.parentElement
    const diagram = el?.closest('.mermaid')
    if (!(diagram instanceof HTMLElement) || !rendered.contains(diagram) || diagram.style.zoom || !q.hasContentBefore(diagram, rendered)) return null
    return diagram
  }

  /** Largest scale (2 decimals) at which `diagram` fits the room left on the page, or NaN. */
  function fittingScale(diagram: HTMLElement, rendered: Element, page: PageBox): number {
    const content = rendered.closest('.pagedjs_page_content') ?? rendered
    const bottom = content.getBoundingClientRect().bottom
    const end = geo.contentEndBefore(diagram, rendered, page)
    if (end === null) return Number.NaN
    const style = getComputedStyle(diagram)
    const margins = (Number.parseFloat(style.marginTop) || 0) + (Number.parseFloat(style.marginBottom) || 0)
    const zoom = diagram.offsetHeight > 0 ? diagram.getBoundingClientRect().height / diagram.offsetHeight : 1
    const need = diagram.getBoundingClientRect().height + margins * zoom
    const room = bottom - end
    return Math.floor((room / need) * 100) / 100
  }

  /** Does the overflow still start in (or around) `diagram`? */
  function startsAt(next: Range, diagram: Element): boolean {
    const s = q.startOf(next).node
    const e = s instanceof Element ? s : s?.parentElement
    return e ? diagram.contains(e) || e.contains(diagram) : false
  }

  function fitDiagram(overflow: Range, rendered: Element, page: PageBox, bounds: PageBox | undefined, layout: unknown): Range {
    const find = q.findOverflowOf(layout)
    if (!find || !bounds) return overflow
    const diagram = diagramAt(overflow, rendered)
    if (!diagram) return overflow
    const estimate = fittingScale(diagram, rendered, page)
    if (Number.isNaN(estimate) || estimate < MIN_DIAGRAM_SCALE) return overflow
    diagram.setAttribute('data-markoto-fit', '')
    // The estimate can come out a little large (margins, the line box
    // around the image): try a few smaller steps before giving up.
    for (let scale = Math.min(estimate, 1 - DIAGRAM_SCALE_STEP); scale >= MIN_DIAGRAM_SCALE - 0.001; scale = Math.round((scale - DIAGRAM_SCALE_STEP) * 100) / 100) {
      diagram.style.zoom = String(scale)
      const next = find(rendered, bounds)
      // Everything fits now (the diagram ended the document): paged.js's
      // hook can't say "no overflow", so the diagram keeps its size and moves.
      if (!(next instanceof Range)) break
      if (!startsAt(next, diagram)) return next
    }
    diagram.style.removeProperty('zoom')
    diagram.removeAttribute('data-markoto-fit')
    return overflow
  }

  return { splitKeptBlock, fitDiagram }
}
