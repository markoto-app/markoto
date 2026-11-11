/**
 * What a document's custom CSS can hook into, in one place:
 *   - the AI reads `CUSTOM_CSS_AI_REFERENCE` in the `update_theme` tool's
 *     `customCss` field description (static text, so the prompt prefix
 *     stays cacheable);
 *   - the user docs page `content/docs/themes/custom-css.md` documents the
 *     same hooks for people.
 * `tests/unit/theme/customCssReference.test.ts` keeps all three honest: every
 * selector listed here must appear in the real `themeToCss` output, every
 * variable must be defined there, the at-rule lists must match what the
 * sanitizer (`shared/utils/theme/customCss.ts`) accepts and refuses, and the
 * docs page must mention each of them.
 */

export interface CustomCssHook {
  /** Selector as emitted by themeToCss (all document content sits inside `.paged-doc`). */
  selector: string
  /** What it targets, in a few words. */
  what: string
}

/** Document structure: elements and classes the rendered Markdown carries. */
export const CUSTOM_CSS_HOOKS: readonly CustomCssHook[] = [
  { selector: '.paged-doc', what: 'the document body (all text sits inside it); multi-column themes put column-count here' },
  { selector: '.paged-doc h1', what: 'headings h1–h6 (each gets an id from its text)' },
  { selector: '.paged-doc p', what: 'paragraphs' },
  { selector: '.paged-doc a', what: 'links' },
  { selector: '.paged-doc blockquote', what: 'quotes' },
  { selector: '.paged-doc table', what: 'tables (th, td, thead, tbody tr inside)' },
  { selector: '.paged-doc pre', what: 'code blocks (inline code: :not(pre) > code)' },
  { selector: '.paged-doc img', what: 'images' },
  { selector: '.paged-doc figure', what: 'image figures; the caption is figcaption' },
  { selector: '.paged-doc hr', what: 'horizontal rules' },
  { selector: '.paged-doc li.task-list-item', what: 'task-list items' },
  { selector: '.paged-doc .markdown-alert', what: 'alert boxes ([!NOTE] …); also .markdown-alert-note / -tip / -important / -warning / -caution' },
  { selector: '.paged-doc .markdown-alert-title', what: 'the title line of an alert' },
  { selector: '.paged-doc .table-of-contents', what: 'the [[toc]] block' },
  { selector: '.paged-doc .footnote', what: 'footnotes (printed at the foot of the page)' },
  { selector: '.paged-doc .mermaid', what: 'Mermaid diagrams (style the drawing via .mermaid > svg)' },
  { selector: '.paged-doc .katex', what: 'math' },
  { selector: '.paged-doc .page-break', what: 'a <!-- pagebreak --> marker' },
  { selector: '.paged-doc .markoto-dropcap', what: 'the drop-cap letter' }
]

/** Cover page parts (only when the theme's cover page is on). */
export const CUSTOM_CSS_COVER_HOOKS: readonly CustomCssHook[] = [
  { selector: '.paged-doc .markoto-cover', what: 'the whole cover page (spans all columns)' },
  { selector: '.paged-doc .markoto-cover-logo', what: 'the logo' },
  { selector: '.paged-doc .markoto-cover-title', what: 'the title' },
  { selector: '.paged-doc .markoto-cover-subtitle', what: 'the subtitle' },
  { selector: '.paged-doc .markoto-cover-meta', what: 'the author + date block' },
  { selector: '.paged-doc .markoto-cover-author', what: 'one author line' },
  { selector: '.paged-doc .markoto-cover-date', what: 'the date' }
]

/** Custom properties themeToCss defines on `.paged-doc` from the theme's colours. */
export const CUSTOM_CSS_VARIABLES: readonly CustomCssHook[] = [
  { selector: '--doc-brand', what: 'brand / accent colour' },
  { selector: '--doc-secondary', what: 'muted colour for hairlines, captions, borders' },
  { selector: '--doc-text', what: 'body text colour' },
  { selector: '--doc-bg', what: 'paper colour' },
  { selector: '--doc-heading-color', what: 'heading colour' }
]

/** Page-level hooks (paged.js): page box, named cover page, margin boxes. */
export const CUSTOM_CSS_PAGE_HOOKS: readonly CustomCssHook[] = [
  { selector: '@page', what: 'every page: size, margin, and the margin boxes below' },
  { selector: '@page :first', what: 'the first page (also :left / :right for facing pages)' },
  { selector: '@page cover-page', what: 'the cover page sheet' },
  { selector: '@top-center', what: 'header/footer margin boxes: @top-left, @top-center, @top-right, @bottom-left, @bottom-center, @bottom-right; content: counter(page), counter(pages), "text"' }
]

/** At-rules the sanitizer accepts at the top level of custom CSS. */
export const CUSTOM_CSS_ALLOWED_AT_RULES = ['@media', '@supports', '@page', '@keyframes', '@container', '@layer', '@font-feature-values'] as const

/** At-rules (and constructs) the sanitizer refuses — the whole CSS is then not applied. */
export const CUSTOM_CSS_REFUSED_AT_RULES = ['@import', '@font-face', '@namespace', '@property', '@counter-style'] as const

const hookList = (hooks: readonly CustomCssHook[]) => hooks.map(h => `${h.selector} (${h.what})`).join('; ')

/**
 * Concise reference for the AI (tool description). Static: derived only
 * from the constants above, never from request data.
 */
export const CUSTOM_CSS_AI_REFERENCE = [
  `Selectors: ${hookList(CUSTOM_CSS_HOOKS)}.`,
  `Cover page: ${hookList(CUSTOM_CSS_COVER_HOOKS)}.`,
  `Theme colours as variables (use var(--…) so the CSS follows the theme): ${hookList(CUSTOM_CSS_VARIABLES)}.`,
  `Pages: ${hookList(CUSTOM_CSS_PAGE_HOOKS)}.`,
  'Classes you add in the Markdown with attributes ({.name} after a heading, link, image or inline code; on the line after a paragraph, list, quote or table) are styled as `.paged-doc .name` — e.g. a list or quote with {.two-columns} + `.paged-doc .two-columns { column-count: 2; column-gap: 8mm }` gives a two-column section.',
  `Allowed at-rules: ${CUSTOM_CSS_ALLOWED_AT_RULES.join(', ')} (plus margin boxes inside @page). Refused: ${CUSTOM_CSS_REFUSED_AT_RULES.join(', ')}, expression(), behavior / -moz-binding, javascript: / vbscript: URLs, var() inside url()/image-set(); url() only to images uploaded to THIS document (/api/files/<this doc id>/<file id>) or base64 data:image/png|jpeg|gif|webp (no SVG, no external hosts). Max 64 KB. A refused construct fails the whole call with line/column issues: fix and resend.`
].join(' ')
