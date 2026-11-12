import type { BlockQueries } from './blockQueries'

/**
 * Pagination handlers, part 8: display math wider than the column.
 * SELF-CONTAINED like every part (see `blockQueries.ts`).
 *
 * KaTeX splits a formula into one inline box (`.katex-base`) per stretch
 * between the places TeX allows a break — after an outer-level relation or
 * binary operator — and `themeToCss` lets a display wrap there. TeX's own
 * convention for a displayed formula is the other way round: break BEFORE
 * the relation or operator, so the continuation line starts with it, and
 * indent the continuation lines (aligned at the first relation). So:
 *  - `afterParsed` moves each trailing operator (with its spacing) of a
 *    display's box to the start of the next box. Nothing changes on one
 *    line (same boxes, same spacing); a break now falls before it.
 *  - In `layout` (before each overflow check, so the page measures the
 *    final height) a display that wrapped is set flush left with a
 *    hanging indent at the first relation of its first line (2 em when
 *    there is none, or it sits past the middle) and the block of lines is
 *    centred as a whole.
 *  - A single box wider than the column (a big fraction, a matrix, an
 *    aligned block) shrinks the formula, down to MIN_MATH_SCALE.
 */
export function createDisplayMath(q: BlockQueries) {
  const MIN_MATH_SCALE = 0.85
  /** Hanging indent when the first line has no usable relation, in em. */
  const MATH_INDENT_EM = 2
  /** Displays already fitted (a clone laid out again on the next page is a new node). */
  const fitted = new WeakSet<Element>()

  function isOperator(e: Element | undefined): boolean {
    return e !== undefined && (e.classList.contains('mrel') || e.classList.contains('mbin'))
  }

  /** Moves the trailing operator run of `base` (operator + spacing) to the start of `next`. */
  function moveTrailingOperator(base: Element, next: Element): void {
    const kids = Array.from(base.children)
    let j = kids.length - 1
    if (kids[j]?.classList.contains('mspace')) j--
    if (!isOperator(kids[j])) return
    j--
    if (kids[j]?.classList.contains('mspace')) j--
    // Something other than the strut must stay in the box.
    const content = kids.slice(0, j + 1).filter(k => !k.classList.contains('katex-strut'))
    if (content.length === 0) return
    const run = kids.slice(j + 1)
    const strut = next.firstElementChild?.classList.contains('katex-strut') ? next.firstElementChild : null
    const at = strut ? strut.nextSibling : next.firstChild
    for (const k of run) next.insertBefore(k, at)
  }

  function breakBeforeOperators(root: ParentNode): void {
    for (const html of Array.from(root.querySelectorAll('.katex-display > .katex > .katex-html'))) {
      const bases = Array.from(html.children).filter(c => c.classList.contains('katex-base'))
      for (let i = 0; i < bases.length - 1; i++) {
        const base = bases[i]
        const next = bases[i + 1]
        if (base && next && base.nextElementSibling === next) moveTrailingOperator(base, next)
      }
    }
  }

  /** Does this box open with a relation (after its strut and spacing)? */
  function opensWithRelation(base: Element): boolean {
    for (const k of Array.from(base.children)) {
      if (k.classList.contains('katex-strut') || k.classList.contains('mspace')) continue
      return k.classList.contains('mrel')
    }
    return false
  }

  /** A box that starts left of where the one before it ended opens a new line. */
  function opensLine(bases: Element[], i: number): boolean {
    const prev = bases[i - 1]
    const cur = bases[i]
    return i > 0 && prev !== undefined && cur !== undefined && cur.getBoundingClientRect().left < prev.getBoundingClientRect().right - 1
  }

  /** Put each run of boxes from one relation to the next into a no-wrap group. */
  function groupAtRelations(html: Element, bases: Element[]): HTMLElement[] {
    const groups: HTMLElement[] = []
    let run: Element[] = []
    const flush = (): void => {
      const first = run[0]
      if (run.length > 1 && first) {
        const group = document.createElement('span')
        group.className = 'markoto-math-run'
        group.style.setProperty('white-space', 'nowrap')
        html.insertBefore(group, first)
        for (const b of run) group.appendChild(b)
        groups.push(group)
      }
      run = []
    }
    for (const [i, b] of bases.entries()) {
      if (i > 0 && (opensWithRelation(b) || b.previousElementSibling !== (bases[i - 1] ?? null))) flush()
      run.push(b)
    }
    flush()
    return groups
  }

  function ungroup(group: HTMLElement): void {
    const parent = group.parentNode
    if (!parent) return
    while (group.firstChild) parent.insertBefore(group.firstChild, group)
    group.remove()
  }

  /**
   * Shrink the whole formula onto one line when that is enough (a break
   * would strand the left-hand side: "s" over "= <fraction>"), else just
   * enough for its widest piece.
   */
  function shrink(display: Element, katex: HTMLElement, bases: Element[], width: number, natural: number): void {
    const total = bases.reduce((sum, b) => sum + b.getBoundingClientRect().width, 0)
    const whole = Math.floor((width / total) * 100) / 100
    const scale = whole >= MIN_MATH_SCALE ? whole : Math.max(MIN_MATH_SCALE, Math.floor((width / natural) * 100) / 100)
    const em = (Number.parseFloat(getComputedStyle(katex).fontSize) || 16) / (Number.parseFloat(getComputedStyle(display).fontSize) || 16)
    katex.style.setProperty('font-size', `${(em * scale).toFixed(4)}em`)
    display.setAttribute('data-markoto-math-scale', String(scale))
  }

  /**
   * Still too wide at the smallest size. In a multi-column page the
   * formula spans the page (like a wide table) and is fitted again (true);
   * in one column it stays on one line (breaking it would only strand the
   * left-hand side) and runs into the margin.
   */
  function spanOrKeepOnOneLine(rendered: Element, display: Element, katex: HTMLElement, html: HTMLElement): boolean {
    const block = q.topBlock(display, rendered)
    const doc = block.parentElement
    if (doc?.classList.contains('paged-doc') && (Number.parseInt(getComputedStyle(doc).columnCount, 10) || 1) > 1 && block instanceof HTMLElement && !block.style.columnSpan) {
      block.style.setProperty('column-span', 'all')
      block.setAttribute('data-markoto-wide', '')
      katex.style.removeProperty('font-size')
      display.removeAttribute('data-markoto-math-scale')
      fitted.delete(display)
      return true
    }
    html.style.setProperty('white-space', 'nowrap')
    return false
  }

  /**
   * A display that wrapped: flush left with a hanging indent at the first
   * relation of its first line, broken at relations first (TeX's
   * \relpenalty < \binoppenalty — an operator only breaks a run between two
   * relations that is itself too long for a line), centred as a block.
   */
  function hangAtRelation(display: Element, katex: HTMLElement, html: HTMLElement, bases: Element[], width: number, zoom: number): void {
    const box = (): DOMRect => html.getBoundingClientRect()
    const groups = groupAtRelations(html, bases)
    html.style.setProperty('text-align', 'left')
    const left = box().left
    const firstLine: Element[] = []
    for (const [i, b] of bases.entries()) {
      if (opensLine(bases, i)) break
      firstLine.push(b)
    }
    const relation = firstLine.find((b, i) => i > 0 && opensWithRelation(b))
    const fontPx = Number.parseFloat(getComputedStyle(katex).fontSize) || 16
    let indent = relation ? (relation.getBoundingClientRect().left - left) / zoom : MATH_INDENT_EM * fontPx
    if (indent > (width / zoom) / 2) indent = MATH_INDENT_EM * fontPx
    html.style.setProperty('padding-left', `${indent.toFixed(2)}px`)
    html.style.setProperty('text-indent', `${(-indent).toFixed(2)}px`)
    for (let round = 0; round < groups.length; round++) {
      const right = box().right
      const over = groups.find(g => g.isConnected && g.getBoundingClientRect().right > right + 0.5)
      if (!over) break
      ungroup(over)
    }
    // Centre the block of lines: its widest line decides.
    const reach = (Math.max(...bases.map(b => b.getBoundingClientRect().right)) - box().left) / zoom
    const shift = Math.max(0, (width / zoom - reach) / 2)
    if (shift > 0.5) html.style.setProperty('padding-left', `${(indent + shift).toFixed(2)}px`)
    display.setAttribute('data-markoto-math-wrapped', '')
  }

  function fitDisplayMath(rendered: Element, display: Element): void {
    const katex = display.querySelector(':scope > .katex')
    const html = katex?.querySelector(':scope > .katex-html')
    if (!(katex instanceof HTMLElement) || !(html instanceof HTMLElement) || html.offsetWidth === 0) return
    // Remembered outside the DOM: an attribute would restyle the page.
    fitted.add(display)
    const bases = Array.from(html.children).filter(c => c.classList.contains('katex-base'))
    if (bases.length === 0) return
    const width = html.getBoundingClientRect().width
    // Viewport px per CSS px (the preview zooms the pages).
    const zoom = width / html.offsetWidth
    const widestBox = (): number => Math.max(...bases.map(b => b.getBoundingClientRect().width))
    const natural = widestBox()
    if (natural > width + 0.5) shrink(display, katex, bases, width, natural)
    if (widestBox() > width + 0.5) {
      if (spanOrKeepOnOneLine(rendered, display, katex, html)) fitDisplayMath(rendered, display)
      return
    }
    // Line breaks the author wrote (`\\`) are left as they are.
    if (html.querySelector(':scope > .newline')) return
    if (!bases.some((_, i) => opensLine(bases, i))) return
    hangAtRelation(display, katex, html, bases, width, zoom)
  }

  function fitDisplaysOnPage(rendered: Element): void {
    for (const display of Array.from(rendered.querySelectorAll('.katex-display'))) {
      if (!fitted.has(display)) fitDisplayMath(rendered, display)
    }
  }

  return { breakBeforeOperators, fitDisplaysOnPage }
}
