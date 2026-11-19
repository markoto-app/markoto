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
import { documentTexts } from '~~/shared/utils/documents/documentLocale'
import { resolveCitations, resolveCrossrefs, type CitationInputs, type ReferenceProblem } from '../markdown/citationResolve'

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
  /** Document language (`ymeta.language`): citation and cross-reference words. */
  language?: string
  /** The document's bibliography and citation style; null = none. */
  citations?: CitationInputs | null
  /** Unknown citation keys, unknown or duplicate labels (for the editor's warning list). */
  onReferenceProblems?: (problems: ReferenceProblem[]) => void
}): string {
  const { theme, title, date } = opts
  const texts = documentTexts(theme, opts.language)
  // Citations first: a bibliography appended under a new heading takes
  // part in the heading passes below.
  const cites = resolveCitations(opts.bodyHtml, opts.citations ?? null, texts.locale)
  let bodyHtml = pruneTocDepth(cites.html, theme.toc.maxDepth)
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
  // Labelled figures / tables / equations / sections and the references
  // to them; needs the section markers and caption numbers above.
  const xrefs = resolveCrossrefs(bodyHtml, theme, texts.locale, texts.captionLabels)
  bodyHtml = xrefs.html
  opts.onReferenceProblems?.([...cites.problems, ...xrefs.problems])
  if (theme.body.dropCap === true) bodyHtml = wrapFirstLetterAsDropCap(bodyHtml)
  // Lead paragraph + opening words (+ the every-chapter drop cap).
  bodyHtml = markDocumentStructure(bodyHtml, { capChapters: theme.body.dropCap === 'every-chapter' })
  const coverHtml = buildCoverHtml(theme, title || '', date, abstractHtml)
  return sanitizeRenderedHtml(coverHtml + bodyHtml)
}
