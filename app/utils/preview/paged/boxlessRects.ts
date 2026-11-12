/**
 * Pagination handlers, part 7: hidden nodes no longer count as overflow.
 * SELF-CONTAINED like every part (see `blockQueries.ts`).
 *
 * BOXLESS NODES. paged.js finds the overflow by walking the page's nodes
 * and taking the first one whose rect lies right of or below the page. An
 * element with `display: none` (and everything in it) has an all-zero
 * rect — x = 0, which is RIGHT of the page while paged.js lays it out
 * off-screen at negative x. So a hidden `<hr>` always counted as
 * overflowing: the page broke before it (page 1 of a two-column
 * newsletter held only the masthead) and the next page, starting at the
 * same hidden node, repeated its content. A hidden node in a page reports,
 * instead, a zero-size rect where it sits in the flow: the end of the
 * laid-out node before it (or the top of its parent). Layout itself is
 * untouched.
 *
 * Done lazily, in `getBoundingClientRect` itself: only an all-zero rect
 * (no box) of a node inside a page is looked at, and only then is the
 * style asked. Checking every clone as paged.js inserted it (a computed
 * style per node) cost ~8 % of the pagination time of a 70-page document.
 */
export function installBoxlessRects(): void {
  /** Zero-size rect at the end of the last laid-out node before `node` (or the top of its parent). */
  function flowRect(node: Node): DOMRect {
    for (let cur: Node | null = node; cur; cur = cur.parentNode) {
      for (let sib = cur.previousSibling; sib; sib = sib.previousSibling) {
        // A hidden sibling has no client rects either.
        const rects = sib instanceof Element ? Array.from(sib.getClientRects()) : []
        const last = rects[rects.length - 1]
        if (last) return new DOMRect(last.left, last.bottom, 0, 0)
      }
      const parent = cur.parentNode
      if (parent instanceof Element) {
        const first = parent.getClientRects()[0]
        if (first) return new DOMRect(first.left, first.top, 0, 0)
      }
    }
    return new DOMRect()
  }

  /** Is `el` in a page and hidden (itself or an ancestor within the page)? */
  function isBoxless(el: Element): boolean {
    const page = el.closest('.pagedjs_page')
    if (!page) return false
    for (let e: Element | null = el; e && e !== page; e = e.parentElement) {
      if (getComputedStyle(e).display === 'none') return true
    }
    return false
  }

  const nativeRect: unknown = Element.prototype.getBoundingClientRect
  if (typeof nativeRect !== 'function' || Reflect.get(nativeRect, '__markotoBoxless') === true) return
  const rect = function (this: Element): DOMRect {
    const r: unknown = Reflect.apply(nativeRect, this, [])
    if (!(r instanceof DOMRect)) return new DOMRect()
    if (r.x !== 0 || r.y !== 0 || r.width !== 0 || r.height !== 0) return r
    try {
      return isBoxless(this) ? flowRect(this) : r
    } catch {
      return r
    }
  }
  Reflect.set(rect, '__markotoBoxless', true)
  Element.prototype.getBoundingClientRect = rect
}
