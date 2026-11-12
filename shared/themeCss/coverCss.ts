import type { DocTheme } from '../types/theme'
import { pageHeightMm } from '../utils/theme/pageDimensions'
import { coverTitleWeight, repeatTitle, resolveTitleBlock } from '../utils/theme/themeOptions'
import { textAlignToJustifyItems, renderCoverLayoutCss } from './coverLayoutCss'
import { cssFontStack } from './cssValues'

// The cover page, the paper title block and the repeated title.

/**
 * Cover-page CSS. Emitted ONLY when `theme.cover.enabled` is true so
 * unused selectors don't clutter the stylesheet for cover-less themes.
 *
 * Strategy: assign the prepended `<section class="markoto-cover">`
 * (injected by `usePagedPreview.buildCoverHtml`) to a named page
 * (`cover-page`). paged.js then applies `@page cover-page` rules to
 * just that one page — including empty margin boxes that suppress the
 * running header/footer (no page number on a title page).
 */
export function coverBlock(theme: DocTheme): string {
  if (!theme.cover.enabled) return ''
  const layout = theme.cover.layout
  const align = theme.cover.align
  // Horizontal alignment maps text + grid item alignment uniformly.
  const justifyItems = textAlignToJustifyItems(align)
  const titleSize = theme.cover.titleSize
  const subtitleSize = theme.cover.subtitleSize
  // The cover's `@page cover-page { margin: 0 }` zeros the page padding,
  // so the cover element should occupy the full physical page rectangle.
  // We can't use `min-height: 100%` because paged.js's parent chain
  // doesn't expose a fixed height — `1fr` grid rows collapse to 0px.
  // Pull the page height from the central `pageDimensions` table so that
  // adding Legal / A3 to PageSizeSchema fails compile rather than silently
  // shifting cover layouts.
  const coverHeightMm = `${pageHeightMm(theme.page.size, theme.page.orientation)}mm`

  // The cover root is a CSS Grid for `editorial` (rows pin logo to top,
  // title+subtitle at upper third, meta at lower third) and a flex
  // column for the other layouts. The `display` declaration is layout-
  // specific so each composition gets its own vertical rhythm.
  const ctx = { justifyItems, align, coverHeightMm }
  if (layout === 'title-block') return titleBlockCss(theme, align)
  const layoutCss = renderCoverLayoutCss(layout, ctx)
  const caps = resolveTitleBlock(theme).smallCaps ? '\n  font-variant-caps: small-caps;' : ''

  return [
    layoutCss,
    // Multi-column themes put `column-count` on `.paged-doc`, the cover's
    // parent. Without a spanner the cover is laid out inside the first
    // column (half-width band, title centred in the left column). Every
    // cover layout spans the whole page; the columns start after it.
    // ONLY for multi-column themes: in a single-column document the
    // nearest multi-column ancestor is paged.js's own page-content box
    // (it fragments with CSS columns), and a spanning cover there makes
    // paged.js drop everything after the cover (one-page PDF).
    theme.layout.columns > 1
      ? `.paged-doc .markoto-cover {
  column-span: all;
  width: 100%;
}`
      : '',
    `.paged-doc .markoto-cover-logo {
  display: block;
  height: ${theme.brand.logoHeight}px;
  width: auto;
  ${layout === 'editorial' || layout === 'banner' ? '' : 'margin: 0 auto 1.2em auto;'}
}`,
    // The title is an h1: pin style + caps so a per-level h1 look
    // (headings.levels.h1) never leaks onto the cover.
    `.paged-doc .markoto-cover-title {
  font-family: ${cssFontStack(theme.headings.font)};
  font-size: ${titleSize}em;
  font-weight: ${coverTitleWeight(theme)};
  font-style: normal;
  line-height: 1.2;
  letter-spacing: ${theme.headings.letterSpacing}em;
  color: var(--doc-heading-color);
  text-wrap: balance;
  margin: 0 0 0.4em 0;${caps || '\n  font-variant-caps: normal;'}
}
.paged-doc .markoto-cover-title .markoto-nobreak { white-space: nowrap; }`,
    `.paged-doc .markoto-cover-subtitle {
  font-family: ${cssFontStack(theme.body.font)};
  font-size: ${subtitleSize}em;
  font-style: italic;
  color: var(--doc-secondary);
  margin: 0 0 1em 0;${caps}
}`,
    `.paged-doc .markoto-cover-meta {
  font-family: ${cssFontStack(theme.meta.font)};
  font-size: 0.9em;
  color: var(--doc-secondary);
  display: flex;
  flex-direction: column;
  gap: 0.3em;
  margin-top: 1.5em;
}`,
    `.paged-doc .markoto-cover-author {
  font-family: ${cssFontStack(theme.meta.font)};
  font-size: 0.95em;
  color: var(--doc-text);
}`,
    `.paged-doc .markoto-cover-date {
  font-family: ${cssFontStack(theme.meta.font)};
  font-size: 0.85em;
  color: var(--doc-secondary);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}`,
    // `cover.affiliations` under each author (one line per line of text).
    ...(resolveTitleBlock(theme).affiliations.some(a => a.trim() !== '')
      ? [`.paged-doc .markoto-cover-affiliation {
  white-space: pre-line;
  font-size: 0.85em;
  line-height: 1.35;
  color: var(--doc-secondary);
  margin-bottom: 0.4em;
}`]
      : []),
    // The named-page rules suppress all running margin boxes on the
    // cover sheet (no page number, no title bar, no header image).
    // paged.js handles `@page <name>` for any element that opted in
    // via `page: <name>`.
    `@page cover-page {
  margin: 0;
  @top-left { content: ''; }
  @top-center { content: ''; }
  @top-right { content: ''; }
  @bottom-left { content: ''; }
  @bottom-center { content: ''; }
  @bottom-right { content: ''; }
}`
  ].join('\n')
}

/**
 * `cover.repeatTitle`: the title again, bold and centred at text size, at
 * the top of the first text page after a title page (APA §2.11). The
 * element is a `<div class="markoto-repeat-title">` (coverHtml.ts), so it
 * is no heading: no number, no TOC entry, no `{section}`.
 */
export function repeatTitleBlock(theme: DocTheme): string {
  if (!theme.cover.enabled || !repeatTitle(theme)) return ''
  return `.paged-doc .markoto-repeat-title {
  font-family: ${cssFontStack(theme.headings.font)};
  font-weight: 700;
  text-align: center;
  color: var(--doc-heading-color);
  margin: 0 0 ${(theme.body.size * theme.body.lineHeight).toFixed(2)}pt;
  break-after: avoid;
}`
}

/**
 * `cover.layout: 'title-block'` — no cover page: title, subtitle, authors
 * (+ affiliations), date and the abstract open page 1 and the text
 * follows on the same page (arXiv / journal first page). Built by
 * `coverHtml.ts`; the abstract is the document's own leading `Abstract`
 * section, moved in by `app/utils/preview/titleBlock.ts`. Page 1 carries no
 * running header (`@page :first`). `cover.rules` draws heavy rules above
 * and below the title, `cover.smallCaps` sets title + subtitle in small
 * capitals.
 */
function titleBlockCss(theme: DocTheme, align: 'left' | 'center' | 'right'): string {
  const { rules, smallCaps } = resolveTitleBlock(theme)
  const caps = smallCaps ? '\n  font-variant-caps: small-caps;' : ''
  const ruleCss = rules
    ? `\n  border-top: 2pt solid var(--doc-heading-color);\n  border-bottom: 2pt solid var(--doc-heading-color);\n  padding: 0.45em 0 0.5em;`
    : ''
  return [
    theme.layout.columns > 1
      ? `.paged-doc .markoto-cover { column-span: all; width: 100%; }`
      : '',
    `.paged-doc .markoto-title-block {
  text-align: ${align};
  margin: 0 0 ${(theme.body.size * theme.body.lineHeight * 1.6).toFixed(2)}pt 0;
  break-inside: avoid;
}`,
    `.paged-doc .markoto-title-block .markoto-cover-logo {
  display: block;
  height: ${theme.brand.logoHeight}px;
  width: auto;
  margin: 0 ${align === 'left' ? 'auto 0 0' : align === 'right' ? '0 0 auto' : 'auto'} 1.2em;
}`,
    `.paged-doc .markoto-title-block .markoto-cover-title {
  font-family: ${cssFontStack(theme.headings.font)};
  font-size: ${theme.cover.titleSize}em;
  font-weight: ${coverTitleWeight(theme)};
  font-style: normal;
  line-height: 1.2;
  letter-spacing: ${theme.headings.letterSpacing}em;
  color: var(--doc-heading-color);
  text-wrap: balance;
  margin: 0 0 0.6em 0;
  border: none;${ruleCss}${caps || '\n  font-variant-caps: normal;'}
}
.paged-doc .markoto-title-block .markoto-cover-title .markoto-nobreak { white-space: nowrap; }`,
    `.paged-doc .markoto-title-block .markoto-cover-subtitle {
  font-family: ${cssFontStack(theme.body.font)};
  font-size: ${theme.cover.subtitleSize}em;
  color: var(--doc-text);
  margin: 0 0 1.4em 0;${caps}
}`,
    `.paged-doc .markoto-title-block .markoto-cover-authors {
  display: flex;
  flex-wrap: wrap;
  justify-content: ${align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center'};
  gap: 0.9em 3em;
  margin: 0 0 1.2em 0;
}`,
    `.paged-doc .markoto-title-block .markoto-cover-author { font-weight: 700; }
.paged-doc .markoto-title-block .markoto-cover-affiliation { white-space: pre-line; line-height: 1.3; }`,
    `.paged-doc .markoto-title-block .markoto-cover-date { margin: 0 0 1.4em 0; }`,
    `.paged-doc .markoto-abstract {
  margin: 0 auto;
  max-width: 84%;
  text-align: ${theme.body.textAlign === 'justify' ? 'justify' : 'left'};
  font-size: 0.95em;
}
.paged-doc .markoto-abstract p { margin: 0.4em 0; text-indent: 0; }
.paged-doc .markoto-abstract-title {
  font-family: ${cssFontStack(theme.headings.font)};
  font-weight: 700;
  font-size: 1.1em;
  text-align: center;
  font-variant-caps: small-caps;
  letter-spacing: 0.03em;
  color: var(--doc-heading-color);
  margin: 0 0 0.5em 0;
}`,
    `@page :first {
  @top-left { content: none; }
  @top-center { content: none; }
  @top-right { content: none; }
}`
  ].filter(Boolean).join('\n')
}
