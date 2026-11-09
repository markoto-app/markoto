/**
 * paged.js layout handlers for book-quality pagination. paged.js 0.4.3
 * ignores `break-after: avoid-page` on headings, splits tables anywhere
 * (even inside a row), never repeats a table's header row, and leaves a
 * single line of a paragraph at the bottom of a page. These handlers fix
 * that, for all three render paths:
 *
 *  - Keep with next: a heading (or a run of headings) is never the last
 *    thing on a page — it moves to the next page with the block it
 *    introduces.
 *  - Unbreakable blocks: anything with a computed `break-inside: avoid`
 *    (short tables, diagrams, code, quotes, alerts, math — set in
 *    themeToCss) moves to the next page as a whole when it doesn't fit.
 *  - Tables: never split inside a row; keep at least three body rows on
 *    each side of a split (or move the table whole); a table continued on
 *    the next page repeats its `<thead>`.
 *  - Orphans: a paragraph never leaves just one line at the page bottom.
 *  - Widows: a paragraph never carries just one line over to the next
 *    page (the break moves up one line when the paragraph has lines to
 *    spare, otherwise the paragraph moves whole).
 *  - Totals: a closing block of bold rows (Subtotal · VAT · Total) goes
 *    over only together with at least three rows before it.
 *  - Code blocks split with at least three lines on each side.
 *  - Lists: no single item carried over or left behind; short lists move
 *    whole; a list under a heading keeps three items with it.
 *  - Diagrams shrink (down to 75 %) before they jump to the next page.
 *  - A code block's caption (`.code-title`) stays with its block.
 *  - After layout: a plain rule (`<hr>`) that opens or closes a page is
 *    hidden (`data-markoto-page-edge`) — at a page edge it reads as a
 *    stray line; a glyph break (asterism) stays — and the first block on
 *    a page loses its top margin (`data-markoto-page-top`).
 *  - paged.js fixes: hidden (`display: none`) nodes no longer count as
 *    overflow, and the rules paged.js rewrites (`+`, `-of-type`) keep
 *    their specificity.
 *
 * Every move is guarded: it only happens when there is other content on
 * the page before the moved block, so nothing can loop or produce an
 * empty page; a block taller than a page still splits as before.
 *
 * DELIVERY. The function below must stay SELF-CONTAINED (no imports, no
 * references to module scope): the live preview / print iframe runs in an
 * opaque origin and cannot load app scripts, so `previewFrame.ts` inlines
 * `PAGED_HANDLERS_SCRIPT` (this function's source) into the srcdoc as a
 * nonce'd inline script. The server render page calls it directly.
 * `tests/dom/pagedHandlers.test.ts` evaluates the stringified source to
 * make sure it still works stand-alone.
 */

/** The bits of the paged.js global the handlers use. */
export interface PagedGlobal {
  Handler: new (chunker: unknown, polisher: unknown, caller: unknown) => object
  registerHandlers: (...handlers: unknown[]) => void
}

/** paged.js global as the render page drives it. */
export interface PagedRuntime extends PagedGlobal {
  Previewer: new () => {
    preview: (html: string, stylesheets: Array<Record<string, string>>, mount: HTMLElement) => Promise<{ total: number }>
  }
}

export function isPagedRuntime(value: unknown): value is PagedRuntime {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.Previewer === 'function' && typeof v.Handler === 'function' && typeof v.registerHandlers === 'function'
}

export function registerPagedHandlers(paged: PagedGlobal): void {
  const flag = '__markotoPagedHandlers'
  if (Reflect.get(paged, flag) === true) return
  Reflect.set(paged, flag, true)

  const HEADING = /^H[1-6]$/
  /**
   * Kept with the block after it: headings, definition-list terms,
   * code-block captions, table captions set above the table
   * (`{.table-caption}`), and a short paragraph that ends in a colon
   * ("To run it locally:") — it introduces what follows.
   */
  function keepsWithNext(el: Element): boolean {
    if (HEADING.test(el.nodeName) || el.nodeName === 'DT' || el.classList.contains('code-title') || el.classList.contains('table-caption')) return true
    if (el.nodeName !== 'P' || !/:\s*$/.test(el.textContent ?? '')) return false
    const style = getComputedStyle(el)
    const lh = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4 || 16
    return el instanceof HTMLElement && el.offsetHeight <= lh * 2.5
  }
  /** Fewest body rows of a split table on either page. */
  const MIN_ROWS = 3

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

  function hasContent(node: Node): boolean {
    if (node.nodeType === 3) return (node.textContent ?? '').trim().length > 0
    if (!(node instanceof Element)) return false
    if ((node.textContent ?? '').trim().length > 0) return true
    return node.querySelector('img, svg, hr, table, .katex') !== null || /^(IMG|SVG|HR|TABLE)$/i.test(node.nodeName)
  }

  /** Is there rendered content on this page before `el`? */
  function hasContentBefore(el: Element, root: Element): boolean {
    let cur: Element | null = el
    while (cur && cur !== root) {
      let sib = cur.previousSibling
      while (sib) {
        if (hasContent(sib)) return true
        sib = sib.previousSibling
      }
      cur = cur.parentElement
    }
    return false
  }

  /** Content before `el` inside `parent` only. */
  function hasContentBeforeIn(el: Element, parent: Element): boolean {
    for (let sib = el.previousSibling; sib; sib = sib.previousSibling) {
      if (hasContent(sib)) return true
    }
    return el.parentElement !== parent && el.parentElement !== null && hasContentBeforeIn(el.parentElement, parent)
  }

  function prevElement(el: Element): Element | null {
    let sib = el.previousSibling
    while (sib) {
      if (sib instanceof Element) return sib
      if (hasContent(sib)) return null
      sib = sib.previousSibling
    }
    return null
  }

  /** The node the overflow range starts at, and whether it starts mid-text. */
  function startOf(range: Range): { node: Node | null, midText: boolean } {
    const c = range.startContainer
    if (c.nodeType === 3) return { node: c, midText: range.startOffset > 0 }
    return { node: c.childNodes[range.startOffset] ?? c, midText: false }
  }

  function avoidsBreakInside(el: Element): boolean {
    const v = getComputedStyle(el).breakInside
    return v === 'avoid' || v === 'avoid-page'
  }

  /*
   * GEOMETRY. paged.js lays a page out as a column box: whatever doesn't
   * fit flows into the NEXT column, to the right of the page and starting
   * at its top — not below it. So positions of overflowing content say
   * nothing about "how far down"; the helpers below count line boxes on
   * either side of the page's right edge instead, and measure free space
   * against the page's bottom. Counting lines (not pixels) also keeps
   * them right under the preview's CSS `zoom`.
   */

  /** The page area paged.js lays out into (its `bounds`). */
  interface PageBox { left: number, right: number, top: number, bottom: number }

  /** Is this rect in the page being laid out (not in the overflow column to its right)? */
  function onPage(r: DOMRect, page: PageBox): boolean {
    return r.left < page.right - 1
  }

  /** One line of `el` in viewport px (the preview zooms the pages; computed px are unzoomed). */
  function linePx(el: Element): number {
    const style = getComputedStyle(el)
    const lh = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4 || 16
    const layout = el instanceof HTMLElement ? el.offsetHeight : 0
    const rendered = el.getBoundingClientRect().height
    return lh * (layout > 0 && rendered > 0 ? rendered / layout : 1)
  }

  /** Line boxes of `range` on the page (`here`) or in the overflow (`!here`). */
  function lineTops(range: Range, page: PageBox, here: boolean, lh: number): number[] {
    const tops = Array.from(range.getClientRects())
      .filter(r => r.width > 0 && r.height > 0 && onPage(r, page) === here)
      .map(r => r.top)
      .sort((x, y) => x - y)
    const lines: number[] = []
    for (const t of tops) {
      const last = lines[lines.length - 1]
      if (last === undefined || t - last > lh / 2) lines.push(t)
    }
    return lines
  }

  function rangeFrom(block: Element, range: Range, toEnd: boolean): Range {
    const r = document.createRange()
    if (toEnd) {
      r.setStart(range.startContainer, range.startOffset)
      r.setEnd(block, block.childNodes.length)
    } else {
      r.setStart(block, 0)
      r.setEnd(range.startContainer, range.startOffset)
    }
    return r
  }

  /** Lines of `block` that stay on the page before the break. */
  function linesAbove(block: Element, range: Range, page: PageBox): number {
    return lineTops(rangeFrom(block, range, false), page, true, linePx(block)).length
  }

  /** Lines of `block` that would go over to the next page. */
  function linesBelow(block: Element, range: Range, page: PageBox): number {
    return lineTops(rangeFrom(block, range, true), page, false, linePx(block)).length
  }

  /**
   * The start of the last line of `block` on the page — breaking there
   * carries one more line over (widow fix). Binary search over the text
   * before the break for the first character on that line.
   */
  function oneLineUp(block: Element, range: Range, page: PageBox): Range | null {
    const lh = linePx(block)
    const lines = lineTops(rangeFrom(block, range, false), page, true, lh)
    const lastTop = lines[lines.length - 1]
    if (lastTop === undefined || lines.length < 3) return null
    const texts: Text[] = []
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n instanceof Text) {
        if (n === range.startContainer) {
          texts.push(n)
          break
        }
        const pos = range.comparePoint(n, 0)
        if (pos >= 0) break
        texts.push(n)
      }
    }
    const probe = document.createRange()
    const topAt = (t: Text, i: number): number => {
      probe.setStart(t, i)
      probe.setEnd(t, Math.min(t.length, i + 1))
      const r = Array.from(probe.getClientRects()).find(x => x.width > 0 && onPage(x, page))
      return r ? r.top : Number.POSITIVE_INFINITY
    }
    for (const t of texts) {
      const end = t === range.startContainer ? range.startOffset : t.length
      if (end === 0 || topAt(t, end - 1) < lastTop - lh / 2) continue
      let lo = 0
      let hi = end - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (topAt(t, mid) >= lastTop - lh / 2) hi = mid
        else lo = mid + 1
      }
      const at = document.createRange()
      at.setStart(t, lo)
      return at
    }
    return null
  }

  /** The block (child of the document container) holding `el`. */
  function topBlock(el: Element, root: Element): Element {
    let cur = el
    while (cur.parentElement && cur.parentElement !== root && !cur.parentElement.classList.contains('paged-doc')) {
      cur = cur.parentElement
    }
    return cur
  }

  /** Most lines that may sit between a heading and the page end before the heading moves along. */
  const NEAR_LINES = 3

  /**
   * The heading (top of a heading run) that would end up with fewer than
   * NEAR_LINES lines of its section under it on this page, or null.
   * `moving`: the block holding the break goes over whole.
   */
  function headingNearBreak(el: Element, root: Element, page: PageBox, moving = false): Element | null {
    const block = topBlock(el, root)
    const limit = NEAR_LINES * linePx(root.querySelector('p') ?? block)
    // A box split by the break has one client rect per fragment; only the
    // ones on this page count.
    const here = (e: Element | null): DOMRect[] => e ? Array.from(e.getClientRects()).filter(r => r.height > 0 && onPage(r, page)) : []
    // Where this page's text ends (not the page box: the footnote area
    // sits below it).
    // (`moving`: the whole block goes to the next page, nothing of it stays.)
    const ends = [...(moving ? [] : here(block)), ...here(prevElement(block))].map(r => r.bottom)
    if (ends.length === 0) return null
    const end = Math.max(...ends)
    const room = (e: Element): number | null => {
      const tops = here(e).map(r => r.top)
      return tops.length ? end - Math.min(...tops) : null
    }
    // The block holding the break: what of it stays on this page counts too.
    const blockRoom = moving ? null : room(block)
    if (blockRoom !== null && blockRoom > limit) return null
    let lead: Element | null = null
    for (let sib = prevElement(block); sib; sib = prevElement(sib)) {
      if (keepsWithNext(sib)) {
        if (!lead && end - sib.getBoundingClientRect().bottom > limit) return null
        lead = sib
        continue
      }
      const sibRoom = room(sib)
      if (lead || sibRoom === null || sibRoom > limit) break
    }
    return lead
  }

  /** Lists of at most this many items move whole rather than split. */
  const SHORT_LIST = 4
  /** Fewest items of a list kept on the page with the heading above it. */
  const MIN_LIST_ITEMS = 3

  /** Is `el` in the lower part of the page (moving it leaves at most 40 % empty)? */
  function nearPageEnd(el: Element, page: PageBox): boolean {
    const top = Array.from(el.getClientRects()).find(r => r.height > 0 && onPage(r, page))?.top
    return top !== undefined && page.bottom - top <= 0.4 * (page.bottom - page.top)
  }

  /**
   * Code blocks split between lines with at least MIN_SPLIT_LINES lines
   * on each side: when fewer would go over, break earlier; when fewer
   * would stay (or breaking earlier leaves too few), move the block
   * whole. Line numbers come from `data-line` (the page may hold only a
   * fragment of the block; the total is read from the source).
   */
  function codeBreak(pre: Element, range: Range, root: Element, siblingsFrom: (el: Element) => Element[] | null): Element | null {
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
    const whole = hasContentBefore(block, root) ? block : null
    if (staying < MIN_SPLIT_LINES) return staying > 0 || breakAt !== lines[0] ? whole : null
    if (carried >= MIN_SPLIT_LINES) return null
    const earlier = total - MIN_SPLIT_LINES + 1
    if (earlier - first >= MIN_SPLIT_LINES) return lines.find(l => num(l) === earlier) ?? whole
    return whole
  }

  /** Where the page should break instead, or null to keep paged.js's choice. */
  function adjustedBreak(range: Range, root: Element, page: PageBox, siblingsFrom: (el: Element) => Element[] | null): Element | Range | null {
    const rowsFrom = (el: Element): number | null => siblingsFrom(el)?.length ?? null
    const { node, midText } = startOf(range)
    if (!node) return null
    const el = node instanceof Element ? node : node.parentElement
    if (!el || !root.contains(el)) return null

    let target: Element | null = null
    // 1. Never break inside an unbreakable block (outermost wins).
    for (let n: Element | null = el; n && n !== root; n = n.parentElement) {
      if (avoidsBreakInside(n)) target = n
    }
    // 2. Tables: break between rows; never leave only the header row
    //    behind — then the whole table moves. A first row that can't move
    //    (top of a continuation page) keeps paged.js's own break, so a
    //    row taller than a page can't loop.
    if (!target) {
      // paged.js can start the overflow at the <tbody> itself: that is its first row.
      const tr = el.nodeName === 'TBODY' ? el.querySelector(':scope > tr') : el.closest('tr')
      const table = tr?.closest('table')
      if (tr && table && root.contains(tr)) {
        const inHead = tr.parentElement?.nodeName === 'THEAD'
        const bodyRows = Array.from(table.querySelectorAll(':scope > tbody > tr'))
        const rowIndex = bodyRows.indexOf(tr)
        if (inHead || rowIndex <= 0) {
          if (!hasContentBefore(table, root)) return null
          target = table
        } else {
          target = tr
          // At least MIN_ROWS body rows on each side of a split: carry more
          // rows over when too few would follow, move the whole table when
          // too few would stay (a table that starts at the top of a page
          // keeps paged.js's break — there is nowhere better).
          const after = rowsFrom(tr)
          // A short table split only to fill a page (splitKeptBlock) keeps
          // at least a third of its rows on each side (the page may hold
          // only part of the table yet: count the rest from the source).
          const total = after === null ? bodyRows.length : rowIndex + after
          const least = table.hasAttribute('data-markoto-split') ? Math.max(MIN_ROWS, Math.ceil(total / 3)) : MIN_ROWS
          // A closing block of bold rows (Subtotal / VAT / Total) never
          // goes over alone: it takes at least MIN_ROWS rows along.
          const sourceBody = siblingsFrom(tr)?.[0]?.parentElement
          const totals = sourceBody ? totalRows(Array.from(sourceBody.children), total) : 0
          const carry = Math.max(least, totals > 0 ? totals + MIN_ROWS : 0)
          if (after !== null && after < carry) {
            const back = rowIndex - (carry - after)
            if (back >= least) target = bodyRows[back] ?? tr
            else if (hasContentBefore(table, root)) target = table
          } else if (rowIndex < least && hasContentBefore(table, root)) {
            target = table
          }
        }
      }
    }
    // 2a. Code blocks: at least MIN_SPLIT_LINES lines on each side of a
    //     split — carry more lines over, or move the block whole.
    if (!target) {
      const pre = el.closest('pre')
      if (pre && root.contains(pre) && pre.querySelector('.code-line')) target = codeBreak(pre, range, root, siblingsFrom)
    }
    // 2b. Lists: never carry a single item over to the next page — take
    //     one more along when at least two stay — nor leave a single item
    //     behind. A short list (≤ SHORT_LIST items) moves whole; a list
    //     right under a heading keeps at least MIN_LIST_ITEMS items with
    //     it, or the heading goes along.
    //     (A list item kept whole — `break-inside: avoid` — counts too.)
    if (!target || target.nodeName === 'LI') {
      const li = target ?? el.closest('li')
      const list = li?.parentElement
      if (li && list && root.contains(li) && !li.closest('.table-of-contents')) {
        const items = Array.from(list.children).filter(c => c.nodeName === 'LI')
        const index = items.indexOf(li)
        // (an item that would leave one line behind moves whole: rule 3)
        const breaksBefore = target === li || !midText || linesAbove(li, range, page) < 2
        const after = rowsFrom(li)
        const fresh = !list.hasAttribute('data-split-from') && hasContentBefore(list, root)
        const total = after === null ? items.length : index + after
        const staying = breaksBefore ? index : index + 1
        const lead = prevElement(list)
        if (fresh && staying < total && total <= SHORT_LIST && nearPageEnd(list, page)) target = list
        else if (fresh && staying < MIN_LIST_ITEMS && lead && keepsWithNext(lead) && (list.parentElement === root || list.parentElement?.classList.contains('paged-doc') === true) && nearPageEnd(lead, page)) target = list
        // One item alone at the foot of the page reads as torn off too.
        else if (fresh && staying === 1 && total > 2 && nearPageEnd(list, page)) target = list
        else if (breaksBefore && index >= 2 && after === 1) target = items[index - 1] ?? null
      }
    }
    // 3. Orphans: don't leave a single line of a paragraph behind.
    //    Widows: don't carry a single line over — break one line earlier
    //    when two would stay, else move the paragraph.
    if (!target && midText) {
      const p = el.closest('p, li, dd')
      if (p && root.contains(p)) {
        const above = linesAbove(p, range, page)
        if (above < 2) target = p
        else if (linesBelow(p, range, page) < 2) {
          const earlier = oneLineUp(p, range, page)
          if (earlier) return earlier
          target = p
        }
      }
    }

    // 4. Keep with next: pull the heading(s) right before the block that
    //    now starts the next page along with it.
    let first = target ?? (midText ? null : el)
    // An inline start (`<strong>` opening a paragraph) stands for its block.
    while (first?.parentElement && first.parentElement !== root
      && !first.parentElement.classList.contains('paged-doc') && prevElement(first) === null
      && !hasContentBeforeIn(first, first.parentElement)) {
      first = first.parentElement
    }
    if (first) {
      let lead: Element = first
      let prev = prevElement(lead)
      while (prev && keepsWithNext(prev)) {
        lead = prev
        prev = prevElement(lead)
      }
      if (lead !== first && hasContentBefore(lead, root)) return lead
    }
    // 5. …and a heading followed by only a line or two before the break
    //    (one list item, the start of a paragraph) goes over with them.
    const moving = target !== null && first !== null && first.contains(target) && topBlock(first, root) === first
    const near = headingNearBreak(first ?? el, root, page, moving)
    if (near && hasContentBefore(near, root)) return near
    return target && hasContentBefore(target, root) ? target : null
  }

  /*
   * COLUMN BREAKS. In a multi-column document the breaks between the
   * columns of one page are Chromium's (paged.js only breaks pages), and
   * Chromium ignores `break-after: avoid` there: a heading could end a
   * column with its text at the top of the next one. Before every
   * overflow check (the `layout` hook) a heading — or a definition term,
   * a code-block title, a table caption, a short lead-in ending in a
   * colon — that ends a
   * column, or has fewer than NEAR_LINES lines of its block under it
   * there, gets a forced column break (`data-markoto-column-break`), so
   * it opens the next column with its block. Breaks at the page end are
   * left to onOverflow.
   */
  function keepWithNextAcrossColumns(rendered: Element): void {
    const doc = rendered.querySelector('.paged-doc') ?? rendered.closest('.paged-doc')
    if (!(doc instanceof HTMLElement)) return
    const style = getComputedStyle(doc)
    const count = Number.parseInt(style.columnCount, 10) || 1
    if (count < 2 || doc.offsetWidth === 0) return
    const content = doc.closest('.pagedjs_page_content') ?? rendered
    const page: PageBox = content.getBoundingClientRect()
    const box = doc.getBoundingClientRect()
    const zoom = box.width / doc.offsetWidth
    const gap = (Number.parseFloat(style.columnGap) || 0) * zoom
    const stride = (box.width + gap) / count
    const columnOf = (r: DOMRect): number => Math.floor((r.left - box.left + gap / 2) / stride)
    const visible = (e: Element): DOMRect[] => Array.from(e.getClientRects()).filter(r => r.height > 0 && onPage(r, page))
    // A table wider than its column (long unbreakable cells) would run
    // into the next column: it spans the page instead.
    const columnWidth = (doc.offsetWidth - (Number.parseFloat(style.columnGap) || 0) * (count - 1)) / count
    for (const table of Array.from(doc.querySelectorAll(':scope > table'))) {
      if (table instanceof HTMLElement && !table.style.columnSpan && table.offsetWidth > columnWidth + 1) {
        table.style.setProperty('column-span', 'all')
        table.setAttribute('data-markoto-wide', '')
      }
    }
    // Each forced break moves everything after it: measure again.
    for (let round = 0; round < 12; round++) {
      let moved = false
      for (const el of Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6, dt, .code-title, p'))) {
        if (el.hasAttribute('data-markoto-column-break') || !keepsWithNext(el) || el.closest('.markoto-cover, .table-of-contents')) continue
        const next = el.nextElementSibling
        const own = visible(el)
        const last = own[own.length - 1]
        if (!next || !last) continue
        const after = Array.from(next.getClientRects()).filter(r => r.height > 0)
        const first = after[0]
        // Still being laid out, or it starts on the next page (onOverflow's job).
        if (!first || !onPage(first, page)) continue
        const column = columnOf(last)
        const below = after.filter(r => onPage(r, page) && columnOf(r) === column)
        const continues = after.some(r => !onPage(r, page) || columnOf(r) > column)
        if (!continues) continue
        // Lines of the block left under the heading in its column (a box
        // fragment reaches down to the column end, so count line boxes).
        if (below.length > 0) {
          const lines = document.createRange()
          lines.selectNodeContents(next)
          const inColumn = Array.from(lines.getClientRects()).filter(r => r.height > 0 && r.width > 0 && onPage(r, page) && columnOf(r) === column)
          const lh = linePx(next)
          const tops: number[] = []
          for (const t of inColumn.map(r => r.top).sort((x, y) => x - y)) {
            const prev = tops[tops.length - 1]
            if (prev === undefined || t - prev > lh / 2) tops.push(t)
          }
          if (tops.length >= NEAR_LINES) continue
        }
        // Take the whole run of keep-with-next blocks along (a heading over a heading).
        let top: Element = el
        for (let prev = top.previousElementSibling; prev && keepsWithNext(prev); prev = prev.previousElementSibling) {
          const pr = visible(prev)
          const prevLast = pr[pr.length - 1]
          if (!prevLast || columnOf(prevLast) !== column) break
          top = prev
        }
        // Something must stay in this column, above the run.
        const before = top.previousElementSibling
        const beforeRects = before ? visible(before) : []
        const beforeLast = beforeRects[beforeRects.length - 1]
        if (!beforeLast || columnOf(beforeLast) !== column) continue
        if (!(top instanceof HTMLElement)) continue
        // Inline: paged.js takes `break-*` declarations out of stylesheets.
        top.setAttribute('data-markoto-column-break', '')
        top.style.setProperty('break-before', 'column')
        top.style.setProperty('margin-top', '0', 'important')
        moved = true
        break
      }
      if (!moved) return
    }
  }

  /*
   * KEPT-WHOLE BLOCKS vs PAGE-BOTTOM GAPS. Short code blocks (≤ 15 lines)
   * and short tables (≤ 12 rows) are `break-inside: avoid`, so Chromium
   * moves them whole to the next page. When that would leave a large
   * empty band at the bottom of this page — at least GAP_LINES body
   * lines and GAP_SHARE of the text height, counting the heading or
   * lead-in that would go along with the block — the block may split
   * after all: at least a third of it, and at least MIN_SPLIT_LINES code
   * lines / MIN_ROWS table rows, on each side. A table continued on the
   * next page repeats its header; a code block continues in a frame of
   * its own. Otherwise it still moves whole.
   */
  const GAP_LINES = 5
  const GAP_SHARE = 0.1
  const MIN_SPLIT_LINES = 3
  const SOFT_KEEP = /^(PRE|TABLE)$/

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

  function splitKeptBlock(overflow: Range, rendered: Element, page: PageBox, bounds: PageBox | undefined, layout: unknown): Range {
    const find: unknown = typeof layout === 'object' && layout !== null ? Reflect.get(layout, 'findOverflow') : null
    if (typeof find !== 'function' || !bounds) return overflow
    const { node, midText } = startOf(overflow)
    if (!node || midText) return overflow
    const el = node instanceof Element ? node : node.parentElement
    if (!el || !rendered.contains(el)) return overflow
    let block: Element | null = null
    for (let n: Element | null = el; n && n !== rendered; n = n.parentElement) {
      if (avoidsBreakInside(n)) block = n
    }
    if (!block || !isSoftKeep(block) || !hasContentBefore(block, rendered)) return overflow
    // The empty band this page would end with if the block moved whole.
    const content = rendered.closest('.pagedjs_page_content') ?? rendered
    const bottom = content.getBoundingClientRect().bottom
    // A heading / lead-in kept with the block would move along.
    let lead: Element = block
    for (let prev = prevElement(lead); prev && keepsWithNext(prev); prev = prevElement(prev)) lead = prev
    const before = document.createRange()
    before.setStart(rendered, 0)
    before.setEndBefore(lead)
    const ends = Array.from(before.getClientRects()).filter(r => r.height > 0 && onPage(r, page)).map(r => r.bottom)
    if (ends.length === 0) return overflow
    const gap = bottom - Math.max(...ends)
    const lh = linePx(rendered.querySelector('p') ?? block)
    if (gap < GAP_LINES * lh || gap < GAP_SHARE * (page.bottom - page.top)) return overflow
    const undo = loosen(block)
    let next: unknown
    try {
      next = Reflect.apply(find, layout, [rendered, bounds])
    } catch {
      next = null
    }
    if (!(next instanceof Range)) {
      undo()
      return overflow
    }
    // Tables: the row rules in adjustedBreak take it from here.
    if (block.nodeName === 'TABLE' || block.querySelector('table')) return next
    // Code: at least MIN_SPLIT_LINES lines on each side, else move it whole.
    const lines = Array.from(block.querySelectorAll('.code-line'))
    const here = lines.filter(l => Array.from(l.getClientRects()).some(r => r.height > 0 && onPage(r, page))).length
    const least = Math.max(MIN_SPLIT_LINES, Math.ceil(lines.length / 3))
    const staying = Math.min(here, lines.length - least)
    const at = lines[staying]
    if (staying < least || !at) {
      undo()
      return overflow
    }
    if (staying === here) return next
    const range = document.createRange()
    range.setStartBefore(at)
    range.setEnd(next.endContainer, next.endOffset)
    return range
  }

  /*
   * BOXLESS NODES. paged.js finds the overflow by walking the page's
   * nodes and taking the first one whose rect lies right of or below the
   * page. An element with `display: none` (and everything in it) has an
   * all-zero rect — x = 0, which is RIGHT of the page while paged.js lays
   * it out off-screen at negative x. So a hidden `<hr>` always counted as
   * overflowing: the page broke before it (page 1 of a two-column
   * newsletter held only the masthead) and the next page, starting at the
   * same hidden node, repeated its content. Each hidden node rendered
   * into a page reports, instead, a zero-size rect where it sits in the
   * flow: the end of the laid-out node before it (or the top of its
   * parent). Layout itself is untouched.
   */
  const boxless = new WeakSet<Node>()

  function flowRect(node: Node): DOMRect {
    for (let cur: Node | null = node; cur; cur = cur.parentNode) {
      for (let sib = cur.previousSibling; sib; sib = sib.previousSibling) {
        if (boxless.has(sib)) continue
        const rects = sib instanceof Element ? Array.from(sib.getClientRects()) : []
        const last = rects[rects.length - 1]
        if (last) return new DOMRect(last.left, last.bottom, 0, 0)
      }
      const parent = cur.parentNode
      if (parent instanceof Element && !boxless.has(parent)) {
        const first = parent.getClientRects()[0]
        if (first) return new DOMRect(first.left, first.top, 0, 0)
      }
    }
    return new DOMRect()
  }

  function placeBoxless(clone: Node): void {
    const parent = clone.parentNode
    const hidden = (parent !== null && boxless.has(parent)) || (clone instanceof Element && getComputedStyle(clone).display === 'none')
    if (!hidden) return
    boxless.add(clone)
    Object.defineProperty(clone, 'getBoundingClientRect', { configurable: true, value: () => flowRect(clone) })
  }

  /*
   * DIAGRAMS SHRINK BEFORE THEY JUMP. A diagram (`.mermaid`, kept whole)
   * that doesn't fit the rest of the page would move to the next one and
   * leave a large gap. If it fits at MIN_DIAGRAM_SCALE of its size or
   * more, it is scaled down (CSS `zoom` on its box, which survives the
   * img → inline SVG swap after pagination) and the overflow is found
   * again; if it still doesn't fit, the scale is undone and it moves.
   */
  const MIN_DIAGRAM_SCALE = 0.75

  function fitDiagram(overflow: Range, rendered: Element, page: PageBox, bounds: PageBox | undefined, layout: unknown): Range {
    const find: unknown = typeof layout === 'object' && layout !== null ? Reflect.get(layout, 'findOverflow') : null
    if (typeof find !== 'function' || !bounds) return overflow
    const { node, midText } = startOf(overflow)
    if (!node || midText) return overflow
    const el = node instanceof Element ? node : node.parentElement
    const diagram = el?.closest('.mermaid')
    if (!(diagram instanceof HTMLElement) || !rendered.contains(diagram) || diagram.style.zoom || !hasContentBefore(diagram, rendered)) return overflow
    const content = rendered.closest('.pagedjs_page_content') ?? rendered
    const bottom = content.getBoundingClientRect().bottom
    const before = document.createRange()
    before.setStart(rendered, 0)
    before.setEndBefore(diagram)
    const ends = Array.from(before.getClientRects()).filter(r => r.height > 0 && onPage(r, page)).map(r => r.bottom)
    if (ends.length === 0) return overflow
    const style = getComputedStyle(diagram)
    const margins = (Number.parseFloat(style.marginTop) || 0) + (Number.parseFloat(style.marginBottom) || 0)
    const zoom = diagram.offsetHeight > 0 ? diagram.getBoundingClientRect().height / diagram.offsetHeight : 1
    const need = diagram.getBoundingClientRect().height + margins * zoom
    const room = bottom - Math.max(...ends)
    const scale = Math.floor((room / need) * 100) / 100
    if (!(scale >= MIN_DIAGRAM_SCALE) || scale >= 1) return overflow
    diagram.style.zoom = String(scale)
    diagram.setAttribute('data-markoto-fit', '')
    let next: unknown
    try {
      next = Reflect.apply(find, layout, [rendered, bounds])
    } catch {
      next = null
    }
    const still = next instanceof Range && (() => {
      const s = startOf(next).node
      const e = s instanceof Element ? s : s?.parentElement
      return e ? diagram.contains(e) || e.contains(diagram) : false
    })()
    // Everything fits now (the diagram ended the document): paged.js's
    // hook can't say "no overflow", so the diagram keeps its size and moves.
    if (next instanceof Range && !still) return next
    diagram.style.removeProperty('zoom')
    diagram.removeAttribute('data-markoto-fit')
    return overflow
  }

  /**
   * A scene break drawn as a glyph (`hrStyle: 'asterism'`, a template's
   * `* * *`) marks a break exactly where a page turns, so it stays
   * visible at a page edge; only plain rules are hidden there.
   */
  function isOrnament(hr: Element): boolean {
    return ['::before', '::after'].some((p) => {
      const c = getComputedStyle(hr, p).content
      return !/^(?:none|normal|""|''|)$/.test(c)
    })
  }

  class MarkotoPagination extends paged.Handler {
    layout(rendered: Element): void {
      try {
        keepWithNextAcrossColumns(rendered)
      } catch {
        // Keep Chromium's column breaks.
      }
    }

    onOverflow(found: Range | undefined, rendered: Element, bounds?: PageBox, layout?: unknown): Range | undefined {
      if (!found) return undefined
      // paged.js's page area. The rendered box itself can be wider (it
      // holds the overflow column on the first page).
      const page: PageBox = bounds && Number.isFinite(bounds.right) ? bounds : rendered.getBoundingClientRect()
      let overflow: Range
      try {
        overflow = fitDiagram(found, rendered, page, bounds, layout)
        if (overflow === found) overflow = splitKeptBlock(found, rendered, page, bounds, layout)
      } catch {
        overflow = found
      }
      // paged.js only takes a returned range; undefined keeps its own.
      const fallback = overflow === found ? undefined : overflow
      // The whole (unpaginated) document paged.js lays out from, to see
      // how many rows of a table are still to come.
      const chunker: unknown = Reflect.get(this, 'chunker')
      const source: unknown = typeof chunker === 'object' && chunker !== null ? Reflect.get(chunker, 'source') : null
      // Siblings still to come from `tr` / `li` on (itself included), read
      // from the unpaginated source (the page holds only what fit).
      const siblingsFrom = (el: Element): Element[] | null => {
        const ref = el.getAttribute('data-ref')
        // paged.js refs are UUIDs; anything else isn't looked up.
        if (!ref || !/^[\w-]+$/.test(ref)) return null
        if (!(source instanceof Element || source instanceof DocumentFragment)) return null
        const original = source.querySelector(`[data-ref="${ref}"]`)
        if (!original) return null
        const out: Element[] = []
        for (let s: Element | null = original; s; s = s.nextElementSibling) out.push(s)
        return out
      }
      let at: Element | Range | null
      try {
        at = adjustedBreak(overflow, rendered, page, siblingsFrom)
      } catch {
        return fallback
      }
      if (!at || !rendered.lastChild) return fallback
      const range = document.createRange()
      if (at instanceof Range) range.setStart(at.startContainer, at.startOffset)
      else range.setStartBefore(at)
      range.setEndAfter(rendered.lastChild)
      return range
    }

    afterPageLayout(page: Element): void {
      try {
        const content = page.querySelector('.pagedjs_page_content')
        const doc = content?.querySelector('.paged-doc') ?? content
        if (!doc) return
        const blocks = Array.from(doc.children).filter(c => c.nodeName !== 'SCRIPT')
        const first = blocks[0]
        if (first) first.setAttribute('data-markoto-page-top', '')
        const edges = [first, blocks[blocks.length - 1]]
        for (const el of edges) {
          if (el?.nodeName === 'HR' && !isOrnament(el)) el.setAttribute('data-markoto-page-edge', '')
        }
        // An <hr> right after the page-top block that is itself hidden.
        if (first?.hasAttribute('data-markoto-page-edge') && blocks[1]) blocks[1].setAttribute('data-markoto-page-top', '')
      } catch {
        // Cosmetic only — never break pagination.
      }
    }

    renderNode(clone: Node, source: Node): void {
      try {
        placeBoxless(clone)
      } catch {
        // paged.js's own geometry.
      }
      const el = clone instanceof Element ? clone : clone.parentElement
      const table = el?.closest('table')
      if (!table?.hasAttribute('data-split-from')) return
      if (Array.from(table.children).some(c => c.nodeName === 'THEAD')) return
      const sourceEl = source instanceof Element ? source : source.parentElement
      const head = sourceEl?.closest('table')?.querySelector(':scope > thead')
      if (!head) return
      const copy = head.cloneNode(true)
      if (!(copy instanceof Element)) return
      copy.removeAttribute('data-ref')
      for (const d of Array.from(copy.querySelectorAll('[data-ref]'))) d.removeAttribute('data-ref')
      copy.classList.add('markoto-repeated-thead')
      table.insertBefore(copy, table.firstChild)
    }
  }

  paged.registerHandlers(MarkotoPagination)

  const registry: unknown = Reflect.get(paged, 'registeredHandlers')
  /** Prototypes of paged.js's own handler classes that define `method`. */
  function pagedHandlersWith(method: string): object[] {
    if (!Array.isArray(registry)) return []
    return registry.flatMap((h: unknown) => {
      const proto: unknown = typeof h === 'function' ? Reflect.get(h, 'prototype') : null
      return typeof proto === 'object' && proto !== null && typeof Reflect.get(proto, method) === 'function' ? [proto] : []
    })
  }

  /*
   * REWRITTEN SELECTORS KEEP THEIR SPECIFICITY. Two paged.js handlers
   * take rules out of the stylesheet before chunking: Following (every
   * selector containing a "+") and NthOfType (`:first-of-type`,
   * `:last-of-type`, `:nth-of-type`). They mark the matching elements
   * with an id (`data-following` / `data-nth-of-type`) — so a paragraph
   * still counts as "after the heading" on the next page — and re-insert
   * the declarations as `*[data-following*='id']`: specificity (0,1,0),
   * so `h1 + p` lost to any `.paged-doc p` rule. Both build the rule in
   * `processSelectors`; this version inserts
   * `:where(<mark>):is(<original>, :where(<mark>))` instead — exactly the
   * marked elements, with the original selector's specificity. A trailing
   * pseudo-element (`h1 + p::first-line`) stays outside the `:is()`. If
   * the browser refuses the selector, paged.js's own form is used.
   */
  function processSelectors(this: object, parsed: unknown, selectors: unknown): void {
    const sheet: unknown = Reflect.get(this, 'styleSheet')
    if (!(parsed instanceof Element || parsed instanceof DocumentFragment || parsed instanceof Document) || typeof selectors !== 'object' || selectors === null || !(sheet instanceof CSSStyleSheet)) return
    for (const [selector, entry] of Object.entries(selectors)) {
      if (!Array.isArray(entry)) continue
      const [id, declarations] = entry
      if (typeof id !== 'string' || typeof declarations !== 'string' || !/^[\w-]+$/.test(id)) continue
      // "following-<uuid>" → data-following, "nth-of-type-<uuid>" → data-nth-of-type.
      const attr = `data-${id.replace(/-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i, '')}`
      const s = selector.trim()
      const pseudo = /::?(?:before|after|first-line|first-letter|marker|placeholder|selection)$/i.exec(s)?.[0] ?? ''
      const base = s.slice(0, s.length - pseudo.length)
      let elements: Element[]
      try {
        elements = Array.from(parsed.querySelectorAll(base))
      } catch {
        continue
      }
      for (const element of elements) {
        const was = element.getAttribute(attr)
        element.setAttribute(attr, was ? `${was},${id}` : id)
      }
      const mark = `[${attr}*='${id}']`
      try {
        sheet.insertRule(`:where(${mark}):is(${base}, :where(${mark}))${pseudo} { ${declarations}; }`, sheet.cssRules.length)
      } catch {
        sheet.insertRule(`*${mark} { ${declarations}; }`, sheet.cssRules.length)
      }
    }
  }
  for (const proto of pagedHandlersWith('processSelectors')) Reflect.set(proto, 'processSelectors', processSelectors)

  /*
   * FOOTNOTES IN MULTI-COLUMN PAGES. paged.js's Footnotes handler decides
   * where a note goes as if the page had one column: when the note area
   * would grow over the line holding the call, it assumes the call moves
   * to the next page and defers or clips the note. In a multi-column
   * page the call only moves to the next column of the SAME page, so the
   * note ended up on a later page (often one holding nothing else). After
   * paged.js placed a note, this puts it back on the call's page at full
   * height (also when paged.js sized the note area too small for it); if the call really leaves the page, paged.js's overflow
   * removal takes the note along and it is placed again with its call.
   * Single-column pages are left exactly as paged.js lays them out.
   */
  const proto = pagedHandlersWith('moveFootnote')[0]
  const moveFootnote: unknown = proto ? Reflect.get(proto, 'moveFootnote') : null
  if (!proto || typeof moveFootnote !== 'function') return

  /** Whole pixels of two edge properties (paged.js rounds the same way). */
  function edges(el: Element, top: string, bottom: string): number {
    const style = getComputedStyle(el)
    return (Number.parseInt(style.getPropertyValue(top), 10) || 0) + (Number.parseInt(style.getPropertyValue(bottom), 10) || 0)
  }

  function keepNoteOnCallPage(footnoteHandler: object, node: unknown, pageArea: unknown): void {
    if (!(node instanceof HTMLElement) || !(pageArea instanceof Element)) return
    const doc = pageArea.querySelector('.paged-doc')
    if (!doc || (Number.parseInt(getComputedStyle(doc).columnCount, 10) || 1) < 2) return
    const noteArea = pageArea.querySelector('.pagedjs_footnote_area')
    const noteContent = noteArea?.querySelector('.pagedjs_footnote_content')
    const inner = noteContent?.querySelector('.pagedjs_footnote_inner_content')
    const content = pageArea.querySelector('.pagedjs_page_content')
    if (!(inner instanceof HTMLElement) || !noteContent || !content) return
    const ref = node.dataset.ref
    if (!ref) return
    const call = pageArea.querySelector(`[data-footnote-call="${CSS.escape(ref)}"]`)
    const pageRight = content.getBoundingClientRect().right
    if (!call || call.getBoundingClientRect().left >= pageRight - 1) return
    // Deferred to the next page ("no room for the note area"): take it back.
    let changed = false
    const queue: unknown = Reflect.get(footnoteHandler, 'needsLayout')
    if (Array.isArray(queue) && node.parentElement !== inner) {
      const last: unknown = queue[queue.length - 1]
      if (!(last instanceof Element) || last.firstChild !== node) return
      queue.pop()
      inner.appendChild(node)
      node.dataset.footnoteMarker = ref
      node.id = `note-${ref}`
      noteContent.classList.remove('pagedjs_footnote_empty')
      changed = true
    }
    if (node.parentElement !== inner) return
    // Clipped to stop above the call: show the notes at full height.
    const clipped = inner.style.height
    if (clipped) {
      inner.style.removeProperty('height')
      changed = true
    }
    // Room the notes need: their own height plus the note area's padding,
    // margins and borders. paged.js's own measure can come out short (seen
    // in the live preview: one 12px note line, padding and margin left
    // out); the note then overflows its area and is deferred to a page of
    // its own.
    const full = inner.scrollHeight + edges(noteContent, 'padding-top', 'padding-bottom') + edges(noteContent, 'margin-top', 'margin-bottom') + edges(noteContent, 'border-top-width', 'border-bottom-width')
    const current = Number.parseFloat(pageArea instanceof HTMLElement ? pageArea.style.getPropertyValue('--pagedjs-footnotes-height') : '') || 0
    if (!changed && full <= current + 1) return
    // Never more than half the page.
    if (full > pageArea.getBoundingClientRect().height / 2) {
      if (clipped) inner.style.height = clipped
      return
    }
    if (pageArea instanceof HTMLElement) pageArea.style.setProperty('--pagedjs-footnotes-height', `${full}px`)
  }

  Reflect.set(proto, 'moveFootnote', function (this: object, node: unknown, pageArea: unknown, needsNoteCall: unknown): unknown {
    const result: unknown = Reflect.apply(moveFootnote, this, [node, pageArea, needsNoteCall])
    if (needsNoteCall === true) {
      try {
        keepNoteOnCallPage(this, node, pageArea)
      } catch {
        // Keep paged.js's own placement.
      }
    }
    return result
  })
}

/** Inline-script body for the preview / print iframe (see "DELIVERY" above). */
export const PAGED_HANDLERS_SCRIPT = `(${registerPagedHandlers.toString()})(globalThis.Paged);`
