import type { BlockQueries, PageBox } from './blockQueries'
import type { LineGeometry } from './lineGeometry'

/**
 * Pagination handlers, part 5: multi-column pages. SELF-CONTAINED like
 * every part (see `blockQueries.ts`).
 *
 * COLUMN BREAKS. In a multi-column document the breaks between the
 * columns of one page are Chromium's (paged.js only breaks pages), and
 * Chromium ignores `break-after: avoid` there: a heading could end a
 * column with its text at the top of the next one. Before every overflow
 * check (the `layout` hook) a heading, or a definition term, a code-block
 * title, a table caption, a short lead-in ending in a colon, that ends a
 * column, or has fewer than `nearLines` lines of its block under it there,
 * gets a forced column break (`data-markoto-column-break`), so it opens
 * the next column with its block. Breaks at the page end are left to
 * onOverflow.
 */
export function createColumnRules(q: BlockQueries, geo: LineGeometry) {
  interface Columns {
    page: PageBox
    columnOf: (r: DOMRect) => number
    visible: (e: Element) => DOMRect[]
  }

  /**
   * Before a spanning block Chromium balances the columns, and that is
   * where it would put a heading at the foot of the first column and its
   * text at the top of the second (it honours an inline `break-after:
   * avoid` there; paged.js takes `break-*` out of the stylesheets). Written
   * before anything is measured: a style change after a measurement lays
   * the page out once more.
   */
  function avoidBreakAfterLeads(doc: HTMLElement): void {
    for (const el of Array.from(doc.querySelectorAll(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > dl > dt, :scope > .code-block > .code-title'))) {
      if (el instanceof HTMLElement && !el.style.breakAfter) el.style.setProperty('break-after', 'avoid')
    }
    // A lead-in ending in a colon is measured (keepsWithNext): one read, then the writes.
    const leadIns = Array.from(doc.querySelectorAll(':scope > p')).filter(p => p instanceof HTMLElement && !p.style.breakAfter && /:\s*$/.test(p.textContent ?? '') && q.keepsWithNext(p))
    for (const p of leadIns) if (p instanceof HTMLElement) p.style.setProperty('break-after', 'avoid')
  }

  function spanPage(block: HTMLElement): void {
    block.style.setProperty('column-span', 'all')
    block.setAttribute('data-markoto-wide', '')
  }

  /**
   * A table only fits the column by breaking code or words in its cells
   * apart (`overflow-wrap: anywhere` keeps a column's minimum width
   * small): measured once with that switched off (`data-markoto-measure`,
   * themeToCss), it spans when it is wider than the column. Each
   * measurement lays the page out twice, so only a complete table with
   * something that can break apart, code, a word of 16+ characters, is
   * measured, once.
   */
  function spanTableIfUnbroken(table: Element, columnWidth: number, isComplete: (table: Element) => boolean): void {
    if (!(table instanceof HTMLElement) || table.style.columnSpan || !isComplete(table)) return
    table.setAttribute('data-markoto-measured', '')
    if (table.offsetWidth > columnWidth + 1 || getComputedStyle(table).columnSpan === 'all') return
    if (!table.querySelector('code') && !/\S{16}/.test(table.textContent ?? '')) return
    table.setAttribute('data-markoto-measure', '')
    const unbroken = table.offsetWidth
    table.removeAttribute('data-markoto-measure')
    if (unbroken > columnWidth + 1) spanPage(table)
  }

  /**
   * A table wider than its column (long unbreakable cells) or a diagram /
   * figure drawn wider than the column would run into the next column: it
   * spans the page instead. (Code keeps the theme's own wrapping or
   * clipping; display math is fitted by fitDisplayMath.)
   */
  function spanWideBlocks(doc: HTMLElement, columnWidth: number, isComplete: (table: Element) => boolean): void {
    for (const table of Array.from(doc.querySelectorAll(':scope > table:not([data-markoto-measured])'))) {
      spanTableIfUnbroken(table, columnWidth, isComplete)
    }
    for (const block of Array.from(doc.querySelectorAll(':scope > table, :scope > .mermaid, :scope > figure'))) {
      if (block instanceof HTMLElement && !block.style.columnSpan && Math.max(block.offsetWidth, block.scrollWidth) > columnWidth + 1) {
        spanPage(block)
      }
    }
  }

  /** Lines of `next` left in `column` under the heading (a box fragment reaches down to the column end, so count line boxes). */
  function linesInColumn(next: Element, column: number, cols: Columns): number {
    const lines = document.createRange()
    lines.selectNodeContents(next)
    const inColumn = Array.from(lines.getClientRects()).filter(r => r.height > 0 && r.width > 0 && geo.onPage(r, cols.page) && cols.columnOf(r) === column)
    return geo.distinctLines(inColumn.map(r => r.top), geo.linePx(next)).length
  }

  /** Does `el` end its column (or keep too few lines of its block under it there)? Its column, or null. */
  function strandedColumn(el: Element, cols: Columns): number | null {
    const next = el.nextElementSibling
    const own = cols.visible(el)
    const last = own[own.length - 1]
    if (!next || !last) return null
    const after = Array.from(next.getClientRects()).filter(r => r.height > 0)
    const first = after[0]
    // Still being laid out, or it starts on the next page (onOverflow's job).
    if (!first || !geo.onPage(first, cols.page)) return null
    const column = cols.columnOf(last)
    const continues = after.some(r => !geo.onPage(r, cols.page) || cols.columnOf(r) > column)
    if (!continues) return null
    const below = after.filter(r => geo.onPage(r, cols.page) && cols.columnOf(r) === column)
    if (below.length > 0 && linesInColumn(next, column, cols) >= q.limits.nearLines) return null
    return column
  }

  /** The block to start the next column with: the whole run of keep-with-next blocks above `el` in its column, if something stays above it. */
  function columnBreakAt(el: Element, column: number, cols: Columns): HTMLElement | null {
    // Take the whole run of keep-with-next blocks along (a heading over a heading).
    let top: Element = el
    for (let prev = top.previousElementSibling; prev && q.keepsWithNext(prev); prev = prev.previousElementSibling) {
      const pr = cols.visible(prev)
      const prevLast = pr[pr.length - 1]
      if (!prevLast || cols.columnOf(prevLast) !== column) break
      top = prev
    }
    // Something must stay in this column, above the run.
    const before = top.previousElementSibling
    const beforeRects = before ? cols.visible(before) : []
    const beforeLast = beforeRects[beforeRects.length - 1]
    if (!beforeLast || cols.columnOf(beforeLast) !== column) return null
    return top instanceof HTMLElement ? top : null
  }

  /** One forced column break, at the first stranded heading. False when there is none. */
  function breakOneColumn(doc: HTMLElement, cols: Columns): boolean {
    for (const el of Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6, dt, .code-title, p'))) {
      if (el.hasAttribute('data-markoto-column-break') || !q.keepsWithNext(el) || el.closest('.markoto-cover, .table-of-contents')) continue
      const column = strandedColumn(el, cols)
      const top = column === null ? null : columnBreakAt(el, column, cols)
      if (!top) continue
      // Inline: paged.js takes `break-*` declarations out of stylesheets.
      top.setAttribute('data-markoto-column-break', '')
      top.style.setProperty('break-before', 'column')
      top.style.setProperty('margin-top', '0', 'important')
      return true
    }
    return false
  }

  function keepWithNextAcrossColumns(rendered: Element, isComplete: (table: Element) => boolean): void {
    const doc = rendered.querySelector('.paged-doc') ?? rendered.closest('.paged-doc')
    if (!(doc instanceof HTMLElement)) return
    const style = getComputedStyle(doc)
    const count = Number.parseInt(style.columnCount, 10) || 1
    if (count < 2) return
    avoidBreakAfterLeads(doc)
    if (doc.offsetWidth === 0) return
    const content = doc.closest('.pagedjs_page_content') ?? rendered
    const page: PageBox = content.getBoundingClientRect()
    const box = doc.getBoundingClientRect()
    const zoom = box.width / doc.offsetWidth
    const gap = (Number.parseFloat(style.columnGap) || 0) * zoom
    const stride = (box.width + gap) / count
    const cols: Columns = {
      page,
      columnOf: r => Math.floor((r.left - box.left + gap / 2) / stride),
      visible: e => Array.from(e.getClientRects()).filter(r => r.height > 0 && geo.onPage(r, page))
    }
    const columnWidth = (doc.offsetWidth - (Number.parseFloat(style.columnGap) || 0) * (count - 1)) / count
    spanWideBlocks(doc, columnWidth, isComplete)
    // Each forced break moves everything after it: measure again.
    for (let round = 0; round < 12; round++) {
      if (!breakOneColumn(doc, cols)) return
    }
  }

  return { keepWithNextAcrossColumns }
}
