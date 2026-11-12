import type { DocTheme } from '../types/theme'
import { mirrorMargins, resolvePageMargins } from '../utils/theme/themeOptions'
import { CODE_KEEP_TOGETHER_LINES } from './codeCss'
import { cssFontStack } from './cssValues'
import { renderMarginBoxes } from './runningCss'
import type { ThemeRuntime } from './runtime'

// The page box (`@page` size, margins, margin boxes), mirrored spreads, hard
// page breaks, column spanners and break hints.

export function pageBlock(theme: DocTheme, runtime: ThemeRuntime): string {
  const { size, orientation } = theme.page
  const m = resolvePageMargins(theme)
  const textColor = theme.body.color
  const metaFont = theme.meta.font
  const headerSlots = renderMarginBoxes(theme, theme.header, 'top', runtime, textColor, metaFont, m.top)
  const footerSlots = renderMarginBoxes(theme, theme.footer, 'bottom', runtime, textColor, metaFont, m.bottom)
  // One value when the four sides agree (the common case, and the CSS the
  // engine always wrote), else top right bottom left.
  const margin = m.top === m.right && m.top === m.bottom && m.top === m.left
    ? `${m.top}mm`
    : `${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm`
  const secondaryColor = theme.color.secondary
  // The footnote area is a page-level box outside `.paged-doc`, so it does
  // not inherit the body font: without an explicit family the notes fall
  // back to the browser default serif. Footnotes are text, so they use
  // the body font at 0.8 × the body size (not the meta voice — a mono
  // meta font made every footnote look like code).
  return `@page {
  size: ${size} ${orientation};
  margin: ${margin};
${headerSlots}
${footerSlots}
  @footnote {
    /* A short rule over the notes (a third of the text width), as in print. */
    border-top: none;
    background: linear-gradient(${secondaryColor}, ${secondaryColor}) top left / 33% 0.5pt no-repeat;
    padding-top: 5pt;
    margin-top: 10pt;
    font-family: ${cssFontStack(theme.body.font)};
    font-size: ${(theme.body.size * 0.8).toFixed(2)}pt;
    line-height: 1.35;
    color: ${textColor};
  }
}${mirroredPagesBlock(theme)}`
}

/**
 * `page.mirrorMargins`: left-hand (verso) pages swap the left and right
 * margins, so `marginLeft` is the inside margin of every spread. paged.js
 * applies `@page :left` to its `.pagedjs_left_page` pages (the first page
 * is a right-hand page). Nothing when the two sides are equal.
 */
function mirroredPagesBlock(theme: DocTheme): string {
  const m = resolvePageMargins(theme)
  if (!mirrorMargins(theme) || m.left === m.right) return ''
  return `
@page :left {
  margin-left: ${m.right}mm;
  margin-right: ${m.left}mm;
}`
}

/**
 * Hard page break. The \`<!-- pagebreak -->\` marker in source
 * (handled by the custom block rule in renderMarkdown.ts) renders as
 * an empty \`<div class="page-break">\`; \`break-after: page\` tells
 * paged.js to start a new page after it.
 */
export function pageBreakBlock(): string {
  return `.paged-doc .page-break {
  break-after: page;
  page-break-after: always;
  height: 0;
}`
}

/**
 * In multi-column layouts (newsletter, magazine), the doc title and
 * the table of contents read better when they span the full page width
 * rather than getting jammed into the first column. \`column-span: all\`
 * is the standard CSS Multi-column Layout property for this — the
 * spanned element interrupts the column flow, sits across the full
 * content area, and columns resume below it.
 *
 * Only the document's first h1 spans (\`markoto-first-section\`, set by
 * \`composeFinalHtml\`): paged.js clones \`.paged-doc\` onto every page,
 * so \`h1:first-of-type\` matched the first h1 of EVERY page. Both
 * spanners only in multi-column themes: in a single-column document the
 * nearest multicol ancestor is paged.js's own page box, where a spanner's
 * margins stop collapsing with its neighbours (the first h1 of every page
 * sat further from its text than every other h1, and the gap after the
 * TOC depended on what followed it).
 */
export function columnSpanBlock(theme: DocTheme): string {
  if (theme.layout.columns === 1) return ''
  return [
    // With a cover (or title block) the title is there; the first h1 is
    // then just the first section and stays in its column.
    theme.cover.enabled
      ? ''
      : `.paged-doc > h1.markoto-first-section {
  column-span: all;
}`,
    `.paged-doc .table-of-contents {
  column-span: all;
}`
  ].filter(Boolean).join('\n')
}

/**
 * Break hints. paged.js 0.4.3 doesn't honour `break-after: avoid-page`
 * itself; `app/utils/preview/pagedHandlers.ts` implements keep-with-next for
 * headings and moves any block with a computed `break-inside: avoid` to
 * the next page as a whole. The declarations stay as the standard CSS
 * statement of intent (and for engines that do support them).
 *
 * Tables: only SHORT tables (≤ 12 body rows) are kept in one piece —
 * forcing every table onto one page left half-empty pages behind long
 * ones. Long tables split between rows and repeat their header row on
 * the next page (pagedHandlers.ts).
 */
export function breakHints(columns: number): string {
  return [
    `.paged-doc h1, .paged-doc h2, .paged-doc h3, .paged-doc h4, .paged-doc h5, .paged-doc h6 { break-after: avoid-page; break-inside: avoid; }`,
    // Multi-column themes: the column breaks inside a page are the
    // browser's (paged.js only breaks pages), so a heading must not end a
    // column either. Only there: `avoid` (pages + columns) on every theme made
    // Chromium move whole sections to the next page (paged.js measures
    // pages through a column layout of its own).
    columns > 1 ? `.paged-doc h1, .paged-doc h2, .paged-doc h3, .paged-doc h4, .paged-doc h5, .paged-doc h6 { break-after: avoid-column; }` : '',
    `.paged-doc img, .paged-doc blockquote { break-inside: avoid; }`,
    // Short code blocks (and their caption) stay whole; long ones split
    // between lines rather than leaving half a page empty.
    `.paged-doc pre:not(:has(.code-line:nth-of-type(${CODE_KEEP_TOGETHER_LINES + 1}))), .paged-doc .code-block:not(:has(.code-line:nth-of-type(${CODE_KEEP_TOGETHER_LINES + 1}))) { break-inside: avoid; }`,
    // A rule that would open a page (or close one) is hidden by
    // pagedHandlers.ts; never split a heading from what follows.
    `.paged-doc hr[data-markoto-page-edge] { display: none; }`,
    `.paged-doc table:not(:has(tbody tr:nth-child(13))) { break-inside: avoid; }`
  ].filter(Boolean).join('\n')
}
