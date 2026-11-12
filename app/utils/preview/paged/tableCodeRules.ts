import type { BlockQueries } from './blockQueries'

/** Siblings still to come from `tr` / `li` on (itself included), read from the unpaginated source. */
export type SiblingsFrom = (el: Element) => Element[] | null

/**
 * Pagination handlers, part 3: where a table or a code block may break.
 * SELF-CONTAINED like every part (see `blockQueries.ts`).
 *
 *  - Tables: never split inside a row; keep at least `minRows` body rows
 *    on each side of a split (or move the table whole). A closing block
 *    of bold rows (Subtotal · VAT · Total) goes over only together with
 *    at least `minRows` rows before it.
 *  - Code blocks split with at least `minSplitLines` lines on each side.
 */
export function createTableCodeRules(q: BlockQueries) {
  const { minRows, minSplitLines } = q.limits

  /** A totals row: its first cell is all bold (`**Total**`). */
  function isBoldRow(tr: Element): boolean {
    const cell = tr.firstElementChild
    const text = (cell?.textContent ?? '').trim()
    if (!cell || !text) return false
    const bold = Array.from(cell.querySelectorAll('strong, b')).map(b => b.textContent ?? '').join('').trim()
    return bold === text
  }

  /**
   * Rows of the closing totals block of a table body (`rows`, `total`
   * body rows): from the first bold row of the
   * table's tail, allowing single plain rows between bold ones
   * (Subtotal · VAT · Total). The block must end at most one row before
   * the end, and a table of bold row headers (more than half bold, or
   * more than four rows) has none.
   */
  function totalRows(rows: Element[], total: number): number {
    let start = -1
    let gap = 0
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]
      if (row && isBoldRow(row)) {
        start = i
        gap = 0
      } else if (start < 0 ? rows.length - 1 - i >= 1 : ++gap > 1) {
        break
      }
    }
    if (start < 0) return 0
    const size = rows.length - start
    return size <= 4 && size * 2 <= total ? size : 0
  }

  /**
   * The break for a split between body rows (`rowIndex` > 0): at least
   * `minRows` body rows on each side — carry more rows over when too few
   * would follow, move the whole table when too few would stay (a table
   * that starts at the top of a page keeps paged.js's break: there is
   * nowhere better).
   */
  function rowSplit(tr: Element, table: Element, bodyRows: Element[], rowIndex: number, root: Element, siblingsFrom: SiblingsFrom): Element {
    const after = siblingsFrom(tr)?.length ?? null
    // A short table split only to fill a page (splitKeptBlock) keeps
    // at least a third of its rows on each side (the page may hold
    // only part of the table yet: count the rest from the source).
    const total = after === null ? bodyRows.length : rowIndex + after
    const least = table.hasAttribute('data-markoto-split') ? Math.max(minRows, Math.ceil(total / 3)) : minRows
    // A closing block of bold rows (Subtotal / VAT / Total) never
    // goes over alone: it takes at least minRows rows along.
    const sourceBody = siblingsFrom(tr)?.[0]?.parentElement
    const totals = sourceBody ? totalRows(Array.from(sourceBody.children), total) : 0
    const carry = Math.max(least, totals > 0 ? totals + minRows : 0)
    if (after !== null && after < carry) {
      const back = rowIndex - (carry - after)
      if (back >= least) return bodyRows[back] ?? tr
      return q.hasContentBefore(table, root) ? table : tr
    }
    if (rowIndex < least && q.hasContentBefore(table, root)) return table
    return tr
  }

  /**
   * Tables: break between rows; never leave only the header row behind —
   * then the whole table moves. A first row that can't move (top of a
   * continuation page) keeps paged.js's own break (`'keep'`), so a row
   * taller than a page can't loop. Null when `el` is not in a table row.
   */
  function tableBreak(el: Element, root: Element, siblingsFrom: SiblingsFrom): Element | 'keep' | null {
    // paged.js can start the overflow at the <tbody> itself: that is its first row.
    const tr = el.nodeName === 'TBODY' ? el.querySelector(':scope > tr') : el.closest('tr')
    const table = tr?.closest('table')
    if (!tr || !table || !root.contains(tr)) return null
    const inHead = tr.parentElement?.nodeName === 'THEAD'
    const bodyRows = Array.from(table.querySelectorAll(':scope > tbody > tr'))
    const rowIndex = bodyRows.indexOf(tr)
    if (inHead || rowIndex <= 0) return q.hasContentBefore(table, root) ? table : 'keep'
    return rowSplit(tr, table, bodyRows, rowIndex, root, siblingsFrom)
  }

  /**
   * Code blocks split between lines with at least `minSplitLines` lines
   * on each side: when fewer would go over, break earlier; when fewer
   * would stay (or breaking earlier leaves too few), move the block
   * whole. Line numbers come from `data-line` (the page may hold only a
   * fragment of the block; the total is read from the source).
   */
  function codeBreak(pre: Element, range: Range, root: Element, siblingsFrom: SiblingsFrom): Element | null {
    const lines = Array.from(pre.querySelectorAll('.code-line'))
    const num = (l: Element | undefined): number => Number.parseInt(l?.getAttribute('data-line') ?? '', 10)
    const first = num(lines[0])
    // The line the break falls in or before (a break inside a wrapped
    // line carries that line's rest over).
    const breakAt = lines.find(l => l.contains(range.startContainer) || range.comparePoint(l, 0) >= 0)
    const original = siblingsFrom(pre)?.[0]
    const sourceLines = original ? Array.from(original.querySelectorAll('.code-line')) : lines
    const total = num(sourceLines[sourceLines.length - 1])
    const at = num(breakAt)
    if (!Number.isFinite(first) || !Number.isFinite(total) || !Number.isFinite(at)) return null
    const staying = at - first
    const carried = total - at + 1
    const block = pre.parentElement?.classList.contains('code-block') ? pre.parentElement : pre
    const whole = q.hasContentBefore(block, root) ? block : null
    if (staying < minSplitLines) return staying > 0 || breakAt !== lines[0] ? whole : null
    if (carried >= minSplitLines) return null
    const earlier = total - minSplitLines + 1
    if (earlier - first >= minSplitLines) return lines.find(l => num(l) === earlier) ?? whole
    return whole
  }

  /** Code blocks: the code-line rule for a break inside a numbered `<pre>`, else null. */
  function codeBlockBreak(el: Element, range: Range, root: Element, siblingsFrom: SiblingsFrom): Element | null {
    const pre = el.closest('pre')
    if (!pre || !root.contains(pre) || !pre.querySelector('.code-line')) return null
    return codeBreak(pre, range, root, siblingsFrom)
  }

  return { tableBreak, codeBlockBreak }
}

export type TableCodeRules = ReturnType<typeof createTableCodeRules>
