/**
 * Pagination handlers, part 10: fixes to paged.js's own handlers.
 * SELF-CONTAINED like every part (see `blockQueries.ts`). Both take
 * `handlersWith(method)`: the prototypes of paged.js's registered handler
 * classes that define `method`.
 */

/**
 * REWRITTEN SELECTORS KEEP THEIR SPECIFICITY. Two paged.js handlers take
 * rules out of the stylesheet before chunking: Following (every selector
 * containing a "+") and NthOfType (`:first-of-type`, `:last-of-type`,
 * `:nth-of-type`). They mark the matching elements with an id
 * (`data-following` / `data-nth-of-type`): so a paragraph still counts as
 * "after the heading" on the next page, and re-insert the declarations
 * as `*[data-following*='id']`: specificity (0,1,0), so `h1 + p` lost to
 * any `.paged-doc p` rule. Both build the rule in `processSelectors`; this
 * version inserts `:where(<mark>):is(<original>, :where(<mark>))` instead,
 * exactly the marked elements, with the original selector's specificity. A
 * trailing pseudo-element (`h1 + p::first-line`) stays outside the
 * `:is()`. If the browser refuses the selector, paged.js's own form is used.
 */
export function patchSelectorSpecificity(handlersWith: (method: string) => object[]): void {
  /** Marks the elements `base` matches with `id` under `attr`; false when the selector doesn't parse. */
  function markMatches(parsed: Element | DocumentFragment | Document, base: string, attr: string, id: string): boolean {
    let elements: Element[]
    try {
      elements = Array.from(parsed.querySelectorAll(base))
    } catch {
      return false
    }
    for (const element of elements) {
      const was = element.getAttribute(attr)
      element.setAttribute(attr, was ? `${was},${id}` : id)
    }
    return true
  }

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
      if (!markMatches(parsed, base, attr, id)) continue
      const mark = `[${attr}*='${id}']`
      try {
        sheet.insertRule(`:where(${mark}):is(${base}, :where(${mark}))${pseudo} { ${declarations}; }`, sheet.cssRules.length)
      } catch {
        sheet.insertRule(`*${mark} { ${declarations}; }`, sheet.cssRules.length)
      }
    }
  }

  for (const proto of handlersWith('processSelectors')) Reflect.set(proto, 'processSelectors', processSelectors)
}

/**
 * FOOTNOTES IN MULTI-COLUMN PAGES. paged.js's Footnotes handler decides
 * where a note goes as if the page had one column: when the note area
 * would grow over the line holding the call, it assumes the call moves to
 * the next page and defers or clips the note. In a multi-column page the
 * call only moves to the next column of the SAME page, so the note ends up
 * on a later page (often one holding nothing else). After paged.js places
 * a note, this puts it back on the call's page at full height (also when
 * paged.js sized the note area too small for it). If the call really
 * leaves the page, paged.js's overflow removal takes the note along and it
 * is placed again with its call. Single-column pages are left exactly as
 * paged.js lays them out.
 */
export function patchMultiColumnFootnotes(handlersWith: (method: string) => object[]): void {
  const proto = handlersWith('moveFootnote')[0]
  const moveFootnote: unknown = proto ? Reflect.get(proto, 'moveFootnote') : null
  if (!proto || typeof moveFootnote !== 'function') return

  /** Whole pixels of two edge properties (paged.js rounds the same way). */
  function edges(el: Element, top: string, bottom: string): number {
    const style = getComputedStyle(el)
    return (Number.parseInt(style.getPropertyValue(top), 10) || 0) + (Number.parseInt(style.getPropertyValue(bottom), 10) || 0)
  }

  /** The note area of a multi-column page whose call is still on it, or null. */
  function noteAreaFor(node: HTMLElement, pageArea: Element): { inner: HTMLElement, noteContent: Element, ref: string } | null {
    const doc = pageArea.querySelector('.paged-doc')
    if (!doc || (Number.parseInt(getComputedStyle(doc).columnCount, 10) || 1) < 2) return null
    const noteArea = pageArea.querySelector('.pagedjs_footnote_area')
    const noteContent = noteArea?.querySelector('.pagedjs_footnote_content')
    const inner = noteContent?.querySelector('.pagedjs_footnote_inner_content')
    const content = pageArea.querySelector('.pagedjs_page_content')
    if (!(inner instanceof HTMLElement) || !noteContent || !content) return null
    const ref = node.dataset.ref
    if (!ref) return null
    const call = pageArea.querySelector(`[data-footnote-call="${CSS.escape(ref)}"]`)
    const pageRight = content.getBoundingClientRect().right
    if (!call || call.getBoundingClientRect().left >= pageRight - 1) return null
    return { inner, noteContent, ref }
  }

  /**
   * Deferred to the next page ("no room for the note area"): take it back.
   * Null when the note was deferred with others after it (leave it), else
   * whether it was taken back.
   */
  function reclaimDeferred(footnoteHandler: object, node: HTMLElement, area: { inner: HTMLElement, noteContent: Element, ref: string }): boolean | null {
    const queue: unknown = Reflect.get(footnoteHandler, 'needsLayout')
    if (!Array.isArray(queue) || node.parentElement === area.inner) return false
    const last: unknown = queue[queue.length - 1]
    if (!(last instanceof Element) || last.firstChild !== node) return null
    queue.pop()
    area.inner.appendChild(node)
    node.dataset.footnoteMarker = area.ref
    node.id = `note-${area.ref}`
    area.noteContent.classList.remove('pagedjs_footnote_empty')
    return true
  }

  function keepNoteOnCallPage(footnoteHandler: object, node: unknown, pageArea: unknown): void {
    if (!(node instanceof HTMLElement) || !(pageArea instanceof Element)) return
    const area = noteAreaFor(node, pageArea)
    if (!area) return
    const reclaimed = reclaimDeferred(footnoteHandler, node, area)
    if (reclaimed === null || node.parentElement !== area.inner) return
    const { inner, noteContent } = area
    // Clipped to stop above the call: show the notes at full height.
    const clipped = inner.style.height
    if (clipped) inner.style.removeProperty('height')
    const changed = reclaimed || Boolean(clipped)
    // Room the notes need: their own height plus the note area's padding,
    // margins and borders. paged.js's own measure can come out short
    // (padding and margin left out); the note then overflows its area and
    // is deferred to a page of its own.
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
