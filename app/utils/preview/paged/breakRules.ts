import type { BlockQueries, PageBox } from './blockQueries'
import type { LineGeometry } from './lineGeometry'
import type { SiblingsFrom, TableCodeRules } from './tableCodeRules'

/**
 * Pagination handlers, part 4: where a page should break instead of where
 * paged.js chose (`adjustedBreak`), rule by rule. SELF-CONTAINED like every
 * part (see `blockQueries.ts`).
 */
export function createBreakRules(q: BlockQueries, geo: LineGeometry, tables: TableCodeRules) {
  const { shortList, minListItems } = q.limits

  /** A list directly in the document container (not nested in another block). */
  function isTopLevel(list: Element, root: Element): boolean {
    return list.parentNode === root || list.parentElement?.classList.contains('paged-doc') === true
  }

  /**
   * Lists: never carry a single item over to the next page, take one more
   * along when at least two stay, nor leave a single item behind. A short
   * list (≤ shortList items) moves whole; a list right under a heading
   * keeps at least minListItems items with it, or the heading goes along.
   * (A list item kept whole, `break-inside: avoid`, counts too.)
   * Returns the new target, or `target` unchanged.
   */
  function listRule(target: Element | null, el: Element, root: Element, range: Range, page: PageBox, midText: boolean, siblingsFrom: SiblingsFrom): Element | null {
    const li = target ?? el.closest('li')
    const list = li?.parentElement
    if (!li || !list || !root.contains(li) || li.closest('.table-of-contents')) return target
    const items = Array.from(list.children).filter(c => c.nodeName === 'LI')
    const index = items.indexOf(li)
    // (an item that would leave one line behind moves whole: rule 3)
    const breaksBefore = target === li || !midText || geo.linesAbove(li, range, page) < 2
    const after = siblingsFrom(li)?.length ?? null
    const fresh = !list.hasAttribute('data-split-from') && q.hasContentBefore(list, root)
    const total = after === null ? items.length : index + after
    const staying = breaksBefore ? index : index + 1
    const lead = q.prevElement(list)
    if (fresh && staying < total && total <= shortList && geo.nearPageEnd(list, page)) return list
    if (fresh && staying < minListItems && lead && q.keepsWithNext(lead) && isTopLevel(list, root) && geo.nearPageEnd(lead, page)) return list
    // One item alone at the foot of the page reads as torn off too.
    if (fresh && staying === 1 && total > 2 && geo.nearPageEnd(list, page)) return list
    if (breaksBefore && index >= 2 && after === 1) return items[index - 1] ?? null
    return target
  }

  /**
   * Orphans: don't leave a single line of a paragraph behind. Widows: don't
   * carry a single line over, break one line earlier when two would stay
   * (a Range), else move the paragraph. Null when the break is fine.
   */
  function paragraphRule(el: Element, root: Element, range: Range, page: PageBox): Element | Range | null {
    const p = el.closest('p, li, dd')
    if (!p || !root.contains(p)) return null
    if (geo.linesAbove(p, range, page) < 2) return p
    if (geo.linesBelow(p, range, page) >= 2) return null
    return geo.oneLineUp(p, range, page) ?? p
  }

  /** The block a break at `first` opens: an inline start (`<strong>` opening a paragraph) stands for its block. */
  function blockOpenedAt(first: Element, root: Element): Element {
    let cur = first
    while (cur.parentElement && cur.parentElement !== root
      && !cur.parentElement.classList.contains('paged-doc') && q.prevElement(cur) === null
      && !q.hasContentBeforeIn(cur, cur.parentElement)) {
      cur = cur.parentElement
    }
    return cur
  }

  /** Top of the run of keep-with-next blocks (headings, lead-ins) right before `first`. */
  function leadOf(first: Element): Element {
    let lead = first
    for (let prev = q.prevElement(lead); prev && q.keepsWithNext(prev); prev = q.prevElement(lead)) lead = prev
    return lead
  }

  /** Rules 1–3: the block the break has to move to, a Range one line up, or null for paged.js's choice. */
  function targetFor(el: Element, root: Element, range: Range, page: PageBox, midText: boolean, siblingsFrom: SiblingsFrom): Element | Range | 'keep' | null {
    // 1. Never break inside an unbreakable block (outermost wins).
    let target = q.outermostUnbreakable(el, root)
    // 2. Tables between rows; 2a. code blocks between lines.
    if (!target) {
      const table = tables.tableBreak(el, root, siblingsFrom)
      if (table === 'keep') return 'keep'
      target = table ?? tables.codeBlockBreak(el, range, root, siblingsFrom)
    }
    // 2b. Lists.
    if (!target || target.nodeName === 'LI') target = listRule(target, el, root, range, page, midText, siblingsFrom)
    // 3. Orphans and widows.
    if (!target && midText) return paragraphRule(el, root, range, page)
    return target
  }

  /** Where the page should break instead, or null to keep paged.js's choice. */
  function adjustedBreak(range: Range, root: Element, page: PageBox, siblingsFrom: SiblingsFrom): Element | Range | null {
    const start = q.startElement(range, root)
    if (!start) return null
    const { el, midText } = start
    const found = targetFor(el, root, range, page, midText, siblingsFrom)
    if (found === 'keep') return null
    if (found instanceof Range) return found
    const target = found

    // 4. Keep with next: pull the heading(s) right before the block that
    //    now starts the next page along with it.
    const opened = target ?? (midText ? null : el)
    const first = opened ? blockOpenedAt(opened, root) : null
    if (first) {
      const lead = leadOf(first)
      if (lead !== first && q.hasContentBefore(lead, root)) return lead
    }
    // 5. …and a heading followed by only a line or two before the break
    //    (one list item, the start of a paragraph) goes over with them.
    const moving = target !== null && first !== null && first.contains(target) && q.topBlock(first, root) === first
    const near = geo.headingNearBreak(first ?? el, root, page, moving)
    if (near && q.hasContentBefore(near, root)) return near
    return target && q.hasContentBefore(target, root) ? target : null
  }

  return { adjustedBreak }
}
