import type { DocTheme } from '~~/shared/types/theme'
import { buildCoverHtml } from './coverHtml'
import { wrapFirstLetterAsDropCap } from './dropcapWrap'
import { sanitizeRenderedHtml } from '../markdown/sanitizeHtml'
import { dropTitleHeading, extractAbstract, markAbstract, markUnnumbered } from './titleBlock'
import { pruneTocDepth } from './tocDepth'
import { markHeadingStructure } from './headingStructure'
import { markReferences } from '../markdown/references'
import { moveCaptionsBelow } from '../markdown/tableCaptions'
import { numberCaptionsByChapter } from '../markdown/captionNumbers'
import { markDocumentStructure } from './documentMarkers'
import { headingNumbering, resolveCaptions, resolveSectionToken } from '~~/shared/utils/theme/themeOptions'
import { showsTitleItself } from '~~/shared/utils/markdown/markdownTitle'

/**
 * Combines the cover page, the rendered body and the optional drop cap
 * into the HTML string paged.js paginates.
 *
 * Every pipeline composes through this helper so their output stays
 * identical: `usePagedPreview` (live preview iframe), `printPdf`
 * (Cmd/Ctrl+P) and `app/pages/_internal/render/[docId].vue` (server-
 * rendered PDF). Do not call `buildCoverHtml` directly from those.
 *
 * `bodyHtml` is the output of `renderMarkdown` (already mermaid-
 * transformed if appropriate). `date` is the publication date already
 * written out in the document language (`documentTexts`), for the
 * cover's date line.
 *
 * The drop cap targets the body's first `<p>` (the cover never holds a
 * body paragraph: h1/divs, its abstract sits inside `.markoto-cover`).
 * It runs before the opening-words marker (`documentMarkers.ts`), which
 * then continues after the cap.
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
  // A title block prints the title: a leading `# <title>` in the text
  // would repeat it (and, as the first heading, hide the abstract below).
  if (showsTitleItself(theme.cover)) bodyHtml = dropTitleHeading(bodyHtml, title)
  // Papers: the document's leading "Abstract" section moves into the
  // title block on page 1 (app/utils/preview/titleBlock.ts); elsewhere it stays
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
  // the reference list, table captions below their table. `{section}`
  // with its number reads `data-markoto-section` (header.sectionNumber).
  const sectionLabels = resolveSectionToken(theme).number ? headingNumbering(theme) : undefined
  bodyHtml = markHeadingStructure(bodyHtml, numbered, sectionLabels)
  bodyHtml = markReferences(bodyHtml)
  const captions = resolveCaptions(theme)
  if (captions.tablePosition === 'below') bodyHtml = moveCaptionsBelow(bodyHtml)
  if (captions.numbering === 'chapter') bodyHtml = numberCaptionsByChapter(bodyHtml)
  if (theme.body.dropCap === true) bodyHtml = wrapFirstLetterAsDropCap(bodyHtml)
  // Lead paragraph + opening words (+ the every-chapter drop cap).
  bodyHtml = markDocumentStructure(bodyHtml, { capChapters: theme.body.dropCap === 'every-chapter' })
  const coverHtml = buildCoverHtml(theme, title || '', date, abstractHtml)
  return sanitizeRenderedHtml(coverHtml + bodyHtml)
}
