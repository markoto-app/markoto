/**
 * Pagination handlers, part 1: what a block on the page is and what comes
 * before it. Shared by every other part as `q`.
 *
 * Like every part in this folder the function is SELF-CONTAINED (no
 * imports, no references to module scope): it is stringified into the
 * preview iframe (see `../pagedHandlers.ts`, "DELIVERY").
 */

/** The page area paged.js lays out into (its `bounds`). */
export interface PageBox { left: number, right: number, top: number, bottom: number }

export function createBlockQueries() {
  const HEADING = /^H[1-6]$/

  /** Shared minimums of the break rules. */
  const limits = {
    /** Fewest body rows of a split table on either page. */
    minRows: 3,
    /** Fewest code lines on either side of a split code block. */
    minSplitLines: 3,
    /** Most lines that may sit between a heading and the page end before the heading moves along. */
    nearLines: 3,
    /** Lists of at most this many items move whole rather than split. */
    shortList: 4,
    /** Fewest items of a list kept on the page with the heading above it. */
    minListItems: 3
  }

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
    const up = el.parentNode
    return up !== parent && up instanceof Element && hasContentBeforeIn(up, parent)
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

  /** The element the overflow range starts in (null when it starts outside `root`). */
  function startElement(range: Range, root: Element): { el: Element, midText: boolean } | null {
    const { node, midText } = startOf(range)
    if (!node) return null
    const el = node instanceof Element ? node : node.parentElement
    return el && root.contains(el) ? { el, midText } : null
  }

  function avoidsBreakInside(el: Element): boolean {
    const v = getComputedStyle(el).breakInside
    return v === 'avoid' || v === 'avoid-page'
  }

  /** The outermost block between `el` and `root` that must not break inside, or null. */
  function outermostUnbreakable(el: Element, root: Element): Element | null {
    let found: Element | null = null
    for (let n: Element | null = el; n && n !== root; n = n.parentElement) {
      if (avoidsBreakInside(n)) found = n
    }
    return found
  }

  /** The block (child of the document container) holding `el`. */
  function topBlock(el: Element, root: Element): Element {
    let cur = el
    while (cur.parentElement && cur.parentElement !== root && !cur.parentElement.classList.contains('paged-doc')) {
      cur = cur.parentElement
    }
    return cur
  }

  /** paged.js's `layout.findOverflow`, or null when the hook got no layout. */
  function findOverflowOf(layout: unknown): ((rendered: Element, bounds: PageBox) => unknown) | null {
    const find: unknown = typeof layout === 'object' && layout !== null ? Reflect.get(layout, 'findOverflow') : null
    if (typeof find !== 'function') return null
    return (rendered, bounds) => {
      try {
        return Reflect.apply(find, layout, [rendered, bounds])
      } catch {
        return null
      }
    }
  }

  return {
    limits,
    keepsWithNext,
    hasContent,
    hasContentBefore,
    hasContentBeforeIn,
    prevElement,
    startOf,
    startElement,
    avoidsBreakInside,
    outermostUnbreakable,
    topBlock,
    findOverflowOf
  }
}

export type BlockQueries = ReturnType<typeof createBlockQueries>
