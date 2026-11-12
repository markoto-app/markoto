import type { BlockQueries, PageBox } from './blockQueries'

/**
 * Pagination handlers, part 2: line-box geometry on a page being laid out.
 * SELF-CONTAINED like every part (see `blockQueries.ts`); `q` is part 1.
 *
 * GEOMETRY. paged.js lays a page out as a column box: whatever doesn't
 * fit flows into the NEXT column, to the right of the page and starting
 * at its top — not below it. So positions of overflowing content say
 * nothing about "how far down"; the helpers below count line boxes on
 * either side of the page's right edge instead, and measure free space
 * against the page's bottom. Counting lines (not pixels) also keeps them
 * right under the preview's CSS `zoom`.
 */
export function createLineGeometry(q: BlockQueries) {
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

  /** Tops of the distinct lines among `tops` (rects closer than half a line share one). */
  function distinctLines(tops: number[], lh: number): number[] {
    const lines: number[] = []
    for (const t of [...tops].sort((x, y) => x - y)) {
      const last = lines[lines.length - 1]
      if (last === undefined || t - last > lh / 2) lines.push(t)
    }
    return lines
  }

  /** Line boxes of `range` on the page (`here`) or in the overflow (`!here`). */
  function lineTops(range: Range, page: PageBox, here: boolean, lh: number): number[] {
    const tops = Array.from(range.getClientRects())
      .filter(r => r.width > 0 && r.height > 0 && onPage(r, page) === here)
      .map(r => r.top)
    return distinctLines(tops, lh)
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

  /** The text nodes of `block` up to the break (the one holding it included). */
  function textsBeforeBreak(block: Element, range: Range): Text[] {
    const texts: Text[] = []
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!(n instanceof Text)) continue
      if (n === range.startContainer) {
        texts.push(n)
        break
      }
      if (range.comparePoint(n, 0) >= 0) break
      texts.push(n)
    }
    return texts
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
    const probe = document.createRange()
    const topAt = (t: Text, i: number): number => {
      probe.setStart(t, i)
      probe.setEnd(t, Math.min(t.length, i + 1))
      const r = Array.from(probe.getClientRects()).find(x => x.width > 0 && onPage(x, page))
      return r ? r.top : Number.POSITIVE_INFINITY
    }
    const onLastLine = (t: Text, i: number): boolean => topAt(t, i) >= lastTop - lh / 2
    for (const t of textsBeforeBreak(block, range)) {
      const end = t === range.startContainer ? range.startOffset : t.length
      if (end === 0 || !onLastLine(t, end - 1)) continue
      let lo = 0
      let hi = end - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (onLastLine(t, mid)) hi = mid
        else lo = mid + 1
      }
      const at = document.createRange()
      at.setStart(t, lo)
      return at
    }
    return null
  }

  /** Is `el` in the lower part of the page (moving it leaves at most 40 % empty)? */
  function nearPageEnd(el: Element, page: PageBox): boolean {
    const top = Array.from(el.getClientRects()).find(r => r.height > 0 && onPage(r, page))?.top
    return top !== undefined && page.bottom - top <= 0.4 * (page.bottom - page.top)
  }

  /**
   * The heading (top of a heading run) that would end up with fewer than
   * `nearLines` lines of its section under it on this page, or null.
   * `moving`: the block holding the break goes over whole.
   */
  function headingNearBreak(el: Element, root: Element, page: PageBox, moving = false): Element | null {
    const block = q.topBlock(el, root)
    const limit = q.limits.nearLines * linePx(root.querySelector('p') ?? block)
    // A box split by the break has one client rect per fragment; only the
    // ones on this page count.
    const here = (e: Element | null): DOMRect[] => e ? Array.from(e.getClientRects()).filter(r => r.height > 0 && onPage(r, page)) : []
    // Where this page's text ends (not the page box: the footnote area
    // sits below it).
    // (`moving`: the whole block goes to the next page, nothing of it stays.)
    const ends = [...(moving ? [] : here(block)), ...here(q.prevElement(block))].map(r => r.bottom)
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
    for (let sib = q.prevElement(block); sib; sib = q.prevElement(sib)) {
      if (q.keepsWithNext(sib)) {
        if (!lead && end - sib.getBoundingClientRect().bottom > limit) return null
        lead = sib
        continue
      }
      const sibRoom = room(sib)
      if (lead || sibRoom === null || sibRoom > limit) break
    }
    return lead
  }

  /** Bottom of the content on the page before `el` (null when there is none). */
  function contentEndBefore(el: Element, rendered: Element, page: PageBox): number | null {
    const before = document.createRange()
    before.setStart(rendered, 0)
    before.setEndBefore(el)
    const ends = Array.from(before.getClientRects()).filter(r => r.height > 0 && onPage(r, page)).map(r => r.bottom)
    return ends.length === 0 ? null : Math.max(...ends)
  }

  return {
    onPage,
    linePx,
    distinctLines,
    linesAbove,
    linesBelow,
    oneLineUp,
    nearPageEnd,
    headingNearBreak,
    contentEndBefore
  }
}

export type LineGeometry = ReturnType<typeof createLineGeometry>
