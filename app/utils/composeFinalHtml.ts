import type { DocTheme } from '~~/shared/types/theme'
import { buildCoverHtml } from './coverHtml'
import { wrapFirstLetterAsDropCap } from './dropcapWrap'
import { sanitizeRenderedHtml } from './sanitizeHtml'
import { extractAbstract, markAbstract, markUnnumbered } from './titleBlock'
import { pruneTocDepth } from './tocDepth'
import { markHeadingStructure } from './headingStructure'
import { markReferences } from './references'
import { moveCaptionsBelow } from './tableCaptions'
import { headingNumbering, resolveCaptions } from '~~/shared/utils/themeOptions'

/**
 * Combine the cover page + body markdown render + optional drop-cap
 * wrapping into the final HTML string that paged.js paginates.
 *
 * Three pipelines used to call `buildCoverHtml` + `wrapFirstLetterAsDropCap`
 * inline:
 *   - `usePagedPreview` — live editor preview iframe
 *   - `printPdf` — in-browser Print / Cmd+P flow
 *   - `app/pages/_internal/render/[docId].vue` — server-rendered PDF page
 *
 * Centralising the composition guarantees the three outputs stay
 * byte-identical: change the cover layout once, every consumer picks it
 * up. If you find yourself reaching for `buildCoverHtml(...)` directly
 * in any of those three call sites, route through this helper instead.
 *
 * Argument shape: `bodyHtml` is the OUTPUT of `renderMarkdown` (already
 * mermaid-transformed if appropriate). `date` is the publication date
 * already written out in the document language (`documentTexts`), used
 * by the cover's date line. Returns an HTML string that's
 * ready to drop into paged.js's Previewer.preview() call.
 *
 * Cover-first ordering is deliberate: drop-cap targets the first
 * `<p>`; running it AFTER cover injection means it skips past the cover
 * (h1/divs) and lands on the actual first paragraph. Reversing this
 * order would put the drop-cap on the cover subtitle.
 *
 * The composed document is sanitised as a whole (same allowlist as
 * `renderMarkdown`), not only the markdown body: the cover is built from
 * theme values, and the theme can reach a renderer over Y.js without any
 * HTTP validation. Browser-only (DOM + DOMPurify); every caller is.
 */
export function composeFinalHtml(opts: {
  theme: DocTheme
  title: string
  date: string
  bodyHtml: string
}): string {
  const { theme, title, date } = opts
  let bodyHtml = pruneTocDepth(opts.bodyHtml, theme.toc.maxDepth)
  let abstractHtml = ''
  // Papers: the document's leading "Abstract" section moves into the
  // title block on page 1 (app/utils/titleBlock.ts); elsewhere it stays
  // and is only marked so heading numbers skip it.
  const numbered = headingNumbering(theme) !== 'none'
  if (theme.cover.enabled && theme.cover.layout === 'title-block') {
    ({ abstractHtml, bodyHtml } = extractAbstract(bodyHtml))
  } else if (numbered) {
    bodyHtml = markAbstract(bodyHtml)
  }
  // `{.unnumbered}` headings: their TOC entries are skipped by the TOC
  // numbers too (the headings themselves carry the class).
  if (numbered) bodyHtml = markUnnumbered(bodyHtml)
  // Section markers ({section} token, first section, numbering base),
  // the reference list, table captions below their table.
  bodyHtml = markHeadingStructure(bodyHtml, numbered)
  bodyHtml = markReferences(bodyHtml)
  if (resolveCaptions(theme).tablePosition === 'below') bodyHtml = moveCaptionsBelow(bodyHtml)
  const coverHtml = buildCoverHtml(theme, title || '', date, abstractHtml)
  let html = coverHtml + bodyHtml
  if (theme.body.dropCap) {
    html = wrapFirstLetterAsDropCap(html)
  }
  return sanitizeRenderedHtml(html)
}
