import { createBlockQueries } from './paged/blockQueries'
import { createLineGeometry } from './paged/lineGeometry'
import { createTableCodeRules } from './paged/tableCodeRules'
import { createBreakRules } from './paged/breakRules'
import { createColumnRules } from './paged/columnRules'
import { createKeptBlocks } from './paged/keptBlocks'
import { installBoxlessRects } from './paged/boxlessRects'
import { createDisplayMath } from './paged/displayMath'
import { createPageMarks } from './paged/pageMarks'
import { patchMultiColumnFootnotes, patchSelectorSpecificity } from './paged/pagedFixes'
import { createPaginationHandler } from './paged/paginationHandler'

/**
 * paged.js layout handlers for book-quality pagination. paged.js 0.4.3
 * ignores `break-after: avoid-page` on headings, splits tables anywhere
 * (even inside a row), never repeats a table's header row, and leaves a
 * single line of a paragraph at the bottom of a page. These handlers fix
 * that, for all three render paths:
 *
 *  - Keep with next: a heading (or a run of headings) is never the last
 *    thing on a page, it moves to the next page with the block it
 *    introduces.
 *  - Unbreakable blocks: anything with a computed `break-inside: avoid`
 *    (short tables, diagrams, code, quotes, alerts, math, set in
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
 *  - Display math wider than the column breaks before a relation /
 *    operator with the continuation lines hung at the first relation, or
 *    shrinks (down to 85 %) when a piece of it can't break.
 *  - Multi-column: a block wider than a column (table, diagram, math)
 *    spans the page; headings keep with their text in a column.
 *  - A code block's caption (`.code-title`) stays with its block.
 *  - After layout: a plain rule (`<hr>`) that opens or closes a page is
 *    hidden (`data-markoto-page-edge`): at a page edge it reads as a
 *    stray line; a glyph break (asterism) stays, and the first block on
 *    a page loses its top margin (`data-markoto-page-top`).
 *  - paged.js fixes: hidden (`display: none`) nodes no longer count as
 *    overflow, and the rules paged.js rewrites (`+`, `-of-type`) keep
 *    their specificity.
 *
 * Every move is guarded: it only happens when there is other content on
 * the page before the moved block, so nothing can loop or produce an
 * empty page; a block taller than a page still splits as before.
 *
 * STRUCTURE. One part per concern in `./paged/`, each a factory that gets
 * the parts it builds on as arguments: block queries (`q`) → line geometry
 * → table / code rules → break rules (`adjustedBreak`); column rules, kept
 * blocks (split or shrink instead of a gap), display math, page marks, the
 * hidden-node rect fix, the paged.js fixes (selector specificity,
 * multi-column footnotes), and the handler class that calls them per hook.
 * `runPagedHandlers` below wires them in a fixed order.
 *
 * DELIVERY. Every part must stay SELF-CONTAINED (no imports, no
 * references to module scope or to another part by name): the live
 * preview / print iframe runs in an opaque origin and cannot load app
 * scripts, so `previewFrame.ts` inlines `PAGED_HANDLERS_SCRIPT`, the
 * stringified runner applied to the stringified parts, into the srcdoc
 * as a nonce'd inline script. The server render page calls
 * `registerPagedHandlers` directly. `tests/dom/pagedHandlers.test.ts`
 * evaluates the string to make sure it still works stand-alone. Types may
 * be imported (they are erased).
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

/** The parts, by name: the runner reaches them only through this object. */
const PARTS = {
  createBlockQueries,
  createLineGeometry,
  createTableCodeRules,
  createBreakRules,
  createColumnRules,
  createKeptBlocks,
  installBoxlessRects,
  createDisplayMath,
  createPageMarks,
  patchSelectorSpecificity,
  patchMultiColumnFootnotes,
  createPaginationHandler
}

/**
 * Registers the handler once per window and patches paged.js. The order is
 * part of the behaviour: the hidden-node rect fix is in place before the
 * handler registers, and paged.js's own handlers are patched after.
 */
function runPagedHandlers(paged: PagedGlobal, parts: typeof PARTS): void {
  const flag = '__markotoPagedHandlers'
  if (Reflect.get(paged, flag) === true) return
  Reflect.set(paged, flag, true)

  const q = parts.createBlockQueries()
  const geo = parts.createLineGeometry(q)
  const breaks = parts.createBreakRules(q, geo, parts.createTableCodeRules(q))
  const columns = parts.createColumnRules(q, geo)
  const kept = parts.createKeptBlocks(q, geo)
  const math = parts.createDisplayMath(q)
  const marks = parts.createPageMarks()
  parts.installBoxlessRects()

  paged.registerHandlers(parts.createPaginationHandler(paged.Handler, {
    breakBeforeOperators: math.breakBeforeOperators,
    fitDisplaysOnPage: math.fitDisplaysOnPage,
    keepWithNextAcrossColumns: columns.keepWithNextAcrossColumns,
    fitDiagram: kept.fitDiagram,
    splitKeptBlock: kept.splitKeptBlock,
    adjustedBreak: breaks.adjustedBreak,
    sourceOf: marks.sourceOf,
    siblingsInSource: marks.siblingsInSource,
    isComplete: marks.isComplete,
    markPageEdges: marks.markPageEdges,
    repeatTableHead: marks.repeatTableHead
  }))

  const registry: unknown = Reflect.get(paged, 'registeredHandlers')
  /** Prototypes of paged.js's own handler classes that define `method`. */
  function handlersWith(method: string): object[] {
    if (!Array.isArray(registry)) return []
    return registry.flatMap((h: unknown) => {
      const proto: unknown = typeof h === 'function' ? Reflect.get(h, 'prototype') : null
      return typeof proto === 'object' && proto !== null && typeof Reflect.get(proto, method) === 'function' ? [proto] : []
    })
  }
  parts.patchSelectorSpecificity(handlersWith)
  parts.patchMultiColumnFootnotes(handlersWith)
}

/** The render page's entry: the same handlers, called directly. */
export function registerPagedHandlers(paged: PagedGlobal): void {
  runPagedHandlers(paged, PARTS)
}

/** Inline-script body for the preview / print iframe (see "DELIVERY" above). */
export const PAGED_HANDLERS_SCRIPT = `(function registerPagedHandlers(paged) {
  (${runPagedHandlers.toString()})(paged, {
${Object.entries(PARTS).map(([name, fn]) => `    ${name}: ${fn.toString()}`).join(',\n')}
  })
})(globalThis.Paged);`
