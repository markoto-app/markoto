/**
 * Pagination handlers, part 9: the unpaginated source a page is cut from,
 * and the marks a finished page gets. SELF-CONTAINED like every part (see
 * `blockQueries.ts`).
 *
 *  - A table continued on the next page repeats its `<thead>`.
 *  - After layout: a plain rule (`<hr>`) that opens or closes a page is
 *    hidden (`data-markoto-page-edge`): at a page edge it reads as a
 *    stray line; a glyph break (asterism) stays, and the first block on
 *    a page loses its top margin (`data-markoto-page-top`).
 */
export function createPageMarks() {
  /** The whole (unpaginated) document paged.js lays out from. */
  function sourceOf(handler: object): Element | DocumentFragment | null {
    const chunker: unknown = Reflect.get(handler, 'chunker')
    const source: unknown = typeof chunker === 'object' && chunker !== null ? Reflect.get(chunker, 'source') : null
    return source instanceof Element || source instanceof DocumentFragment ? source : null
  }

  /** The element of the source a rendered clone came from. */
  function originalOf(el: Element, source: Element | DocumentFragment | null): Element | null {
    const ref = el.getAttribute('data-ref')
    // paged.js refs are UUIDs; anything else isn't looked up.
    if (!ref || !/^[\w-]+$/.test(ref) || !source) return null
    return source.querySelector(`[data-ref="${ref}"]`)
  }

  /**
   * Siblings still to come from `el` on (itself included), read from the
   * unpaginated source (the page holds only what fit).
   */
  function siblingsInSource(source: Element | DocumentFragment | null): (el: Element) => Element[] | null {
    return (el) => {
      const original = originalOf(el, source)
      if (!original) return null
      const out: Element[] = []
      for (let s: Element | null = original; s; s = s.nextElementSibling) out.push(s)
      return out
    }
  }

  /** Has the page all rows of this table that are still to come (paged.js has moved past it, or its last row is here)? */
  function isComplete(table: Element, source: Element | DocumentFragment | null): boolean {
    if (table.nextSibling) return true
    const original = originalOf(table, source)
    const lastRow = (t: Element): string | null | undefined => Array.from(t.querySelectorAll('tr')).pop()?.getAttribute('data-ref')
    return original !== null && lastRow(original) === lastRow(table)
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

  function markPageEdges(page: Element): void {
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
  }

  /** A table continued from the previous page gets a copy of its header row. */
  function repeatTableHead(clone: Node, source: Node): void {
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

  return { sourceOf, siblingsInSource, isComplete, markPageEdges, repeatTableHead }
}
