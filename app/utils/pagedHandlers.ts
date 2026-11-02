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
  /** Fewest body rows of a split table on either page. */
  const MIN_ROWS = 3

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

  /** Lines of `block` rendered above the text position where the range starts. */
  function linesAbove(block: Element, range: Range): number {
    const c = range.startContainer
    if (c.nodeType !== 3) return 0
    const probe = document.createRange()
    const len = (c.textContent ?? '').length
    const at = Math.min(range.startOffset, Math.max(0, len - 1))
    probe.setStart(c, at)
    probe.setEnd(c, Math.min(len, at + 1))
    const top = probe.getBoundingClientRect().top
    const style = getComputedStyle(block)
    const lh = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4 || 16
    return (top - block.getBoundingClientRect().top) / lh
  }

  /** Where the page should break instead, or null to keep paged.js's choice. */
  function adjustedBreak(range: Range, root: Element, rowsFrom: (tr: Element) => number | null): Element | null {
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
      const tr = el.closest('tr')
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
          if (after !== null && after < MIN_ROWS) {
            const back = rowIndex - (MIN_ROWS - after)
            if (back >= MIN_ROWS) target = bodyRows[back] ?? tr
            else if (hasContentBefore(table, root)) target = table
          } else if (rowIndex < MIN_ROWS && hasContentBefore(table, root)) {
            target = table
          }
        }
      }
    }
    // 3. Orphans: don't leave a single line of a paragraph behind.
    if (!target && midText) {
      const p = el.closest('p, li')
      if (p && root.contains(p) && linesAbove(p, range) < 1.5) target = p
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
      while (prev && HEADING.test(prev.nodeName)) {
        lead = prev
        prev = prevElement(lead)
      }
      if (lead !== first && hasContentBefore(lead, root)) return lead
    }
    return target && hasContentBefore(target, root) ? target : null
  }

  class MarkotoPagination extends paged.Handler {
    onOverflow(overflow: Range | undefined, rendered: Element): Range | undefined {
      if (!overflow) return undefined
      // The whole (unpaginated) document paged.js lays out from, to see
      // how many rows of a table are still to come.
      const chunker: unknown = Reflect.get(this, 'chunker')
      const source: unknown = typeof chunker === 'object' && chunker !== null ? Reflect.get(chunker, 'source') : null
      const rowsFrom = (tr: Element): number | null => {
        const ref = tr.getAttribute('data-ref')
        // paged.js refs are UUIDs; anything else isn't looked up.
        if (!ref || !/^[\w-]+$/.test(ref)) return null
        if (!(source instanceof Element || source instanceof DocumentFragment)) return null
        const original = source.querySelector(`[data-ref="${ref}"]`)
        if (!original) return null
        let n = 1
        for (let s = original.nextElementSibling; s; s = s.nextElementSibling) n++
        return n
      }
      let at: Element | null
      try {
        at = adjustedBreak(overflow, rendered, rowsFrom)
      } catch {
        return undefined
      }
      if (!at || !rendered.lastChild) return undefined
      const range = document.createRange()
      range.setStartBefore(at)
      range.setEndAfter(rendered.lastChild)
      return range
    }

    renderNode(clone: Node, source: Node): void {
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
}

/** Inline-script body for the preview / print iframe (see "DELIVERY" above). */
export const PAGED_HANDLERS_SCRIPT = `(${registerPagedHandlers.toString()})(globalThis.Paged);`
