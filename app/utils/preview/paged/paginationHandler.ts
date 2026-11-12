import type { PageBox } from './blockQueries'

/** The part functions the handler class calls (see `../pagedHandlers.ts`). */
export interface PaginationHooks {
  breakBeforeOperators: (parsed: ParentNode) => void
  fitDisplaysOnPage: (rendered: Element) => void
  keepWithNextAcrossColumns: (rendered: Element, isComplete: (table: Element) => boolean) => void
  fitDiagram: (overflow: Range, rendered: Element, page: PageBox, bounds: PageBox | undefined, layout: unknown) => Range
  splitKeptBlock: (overflow: Range, rendered: Element, page: PageBox, bounds: PageBox | undefined, layout: unknown) => Range
  adjustedBreak: (range: Range, root: Element, page: PageBox, siblingsFrom: (el: Element) => Element[] | null) => Element | Range | null
  sourceOf: (handler: object) => Element | DocumentFragment | null
  siblingsInSource: (source: Element | DocumentFragment | null) => (el: Element) => Element[] | null
  isComplete: (table: Element, source: Element | DocumentFragment | null) => boolean
  markPageEdges: (page: Element) => void
  repeatTableHead: (clone: Node, source: Node) => void
}

/**
 * Pagination handlers, part 11: the paged.js handler class, one method per
 * hook. Every hook is guarded: a failing adjustment falls back to paged.js's
 * own behaviour, never breaks pagination. SELF-CONTAINED like every part
 * (see `blockQueries.ts`).
 */
export function createPaginationHandler(Base: new (chunker: unknown, polisher: unknown, caller: unknown) => object, hooks: PaginationHooks) {
  /** Where the page breaks: the adjusted break, as the range paged.js takes (undefined keeps its own). */
  function breakRange(at: Element | Range, rendered: Element): Range | null {
    if (!rendered.lastChild) return null
    const range = document.createRange()
    if (at instanceof Range) range.setStart(at.startContainer, at.startOffset)
    else range.setStartBefore(at)
    range.setEndAfter(rendered.lastChild)
    return range
  }

  return class MarkotoPagination extends Base {
    afterParsed(parsed: unknown): void {
      if (!(parsed instanceof Element || parsed instanceof DocumentFragment)) return
      try {
        hooks.breakBeforeOperators(parsed)
      } catch {
        // KaTeX's own break points.
      }
    }

    layout(rendered: Element): void {
      try {
        hooks.fitDisplaysOnPage(rendered)
      } catch {
        // KaTeX's own layout.
      }
      try {
        hooks.keepWithNextAcrossColumns(rendered, table => hooks.isComplete(table, hooks.sourceOf(this)))
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
        overflow = hooks.fitDiagram(found, rendered, page, bounds, layout)
        if (overflow === found) overflow = hooks.splitKeptBlock(found, rendered, page, bounds, layout)
      } catch {
        overflow = found
      }
      // paged.js only takes a returned range; undefined keeps its own.
      const fallback = overflow === found ? undefined : overflow
      // The whole (unpaginated) document paged.js lays out from, to see
      // how many rows of a table are still to come.
      const siblingsFrom = hooks.siblingsInSource(hooks.sourceOf(this))
      let at: Element | Range | null
      try {
        at = hooks.adjustedBreak(overflow, rendered, page, siblingsFrom)
      } catch {
        return fallback
      }
      return (at && breakRange(at, rendered)) ?? fallback
    }

    afterPageLayout(page: Element): void {
      try {
        hooks.markPageEdges(page)
      } catch {
        // Cosmetic only: never break pagination.
      }
    }

    renderNode(clone: Node, source: Node): void {
      hooks.repeatTableHead(clone, source)
    }
  }
}
