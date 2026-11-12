import { UNNUMBERED_CLASS } from '../preview/titleBlock'
import { CAPTION_NUMBER_ATTR, SECTION_HEADING_CLASS } from '~~/shared/utils/theme/themeToCss'

/**
 * `blocks.captionNumbering: 'chapter'`: figures and tables numbered within
 * their top-level section ("Figure 3.1", "Table 3.2", theses and books).
 * Writes the number on every table `<caption>` and non-empty `<figcaption>`
 * as `data-markoto-number`; the caption labels print it with `attr()`
 * (themeToCss `captionBlock`). CSS counters can't do it: the reset would
 * have to sit on whichever heading level the document uses for its
 * sections, and paged.js resolves counters per page.
 *
 * The chapter number counts the numbered section headings
 * (`markoto-section-heading` without `{.unnumbered}`), like the heading
 * numbers do. Captions before the first chapter, or in an unnumbered
 * section (Appendix, References), get a plain running number. Runs after
 * `markHeadingStructure` on parsed DOM; the composition is sanitised
 * again afterwards. Browser-only.
 */
export function numberCaptionsByChapter(bodyHtml: string): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = bodyHtml
  const nodes = tpl.content.querySelectorAll(`.${SECTION_HEADING_CLASS}, table > caption, figcaption`)
  if (nodes.length === 0) return bodyHtml
  let chapter = 0
  let inChapter = false
  let tables = 0
  let figures = 0
  for (const el of Array.from(nodes)) {
    if (el.classList.contains(SECTION_HEADING_CLASS)) {
      inChapter = !el.classList.contains(UNNUMBERED_CLASS)
      if (inChapter) chapter++
      tables = 0
      figures = 0
      continue
    }
    // Only what the CSS counts: every table caption, a figcaption that has content (`:not(:empty)`).
    const isTable = el.tagName === 'CAPTION'
    if (!isTable && el.childNodes.length === 0) continue
    const n = isTable ? ++tables : ++figures
    el.setAttribute(CAPTION_NUMBER_ATTR, inChapter ? `${chapter}.${n}` : String(n))
  }
  const wrap = document.createElement('div')
  wrap.append(tpl.content)
  return wrap.innerHTML
}
