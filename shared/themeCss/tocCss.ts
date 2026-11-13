import type { DocTheme } from '../types/theme'
import { cssString, cssFontStack } from './cssValues'
import type { ThemeRuntime } from './runtime'

// The `[[toc]]` table of contents: entries, leaders and page numbers.

/**
 * Auto-generated TOC from \`[[toc]]\` (markdown-it-toc-done-right). Plays
 * to paged.js's killer feature: \`target-counter(attr(href url), page)\`
 * resolves the page number of each TOC link's target heading at print
 * time. The result reads like a real book TOC, heading title on the
 * left, dotted leader, page number on the right.
 *
 * Indentation is by nested \`<ul>\` levels; the renderer emits up to h4.
 * Resetting list-style hides the bullets (typographers don't put
 * bullets next to TOC entries, the dotted leader carries the eye).
 */
export function tocBlock(theme: DocTheme, runtime: ThemeRuntime): string {
  const { maxDepth, showTitle, showPageNumbers, leaderStyle } = theme.toc

  // Renderer always emits up to h4 (4 nested ULs in worst case).
  // `composeFinalHtml` removes the levels beyond maxDepth (pruneTocDepth,
  // paged.js mis-measures hidden lists and broke the TOC after them); the
  // rules below only cover a TOC that reaches the page some other way. depth 2
  // keeps only the second-level ul (h2 entries under h1), so we hide
  // any ul nested 2+ deep inside that.
  const depthHide: string[] = []
  if (maxDepth < 4) depthHide.push(`.paged-doc .table-of-contents ul ul ul ul { display: none; }`)
  if (maxDepth < 3) depthHide.push(`.paged-doc .table-of-contents ul ul ul { display: none; }`)
  if (maxDepth < 2) depthHide.push(`.paged-doc .table-of-contents ul ul { display: none; }`)

  // Optional "Table of Contents" heading rendered via CSS ::before so
  // the source markdown stays clean (no manual heading line above
  // [[toc]]). Title text comes through runtime so it can be localized,
  // themeToCss bakes it into the CSS string at render time.
  const titleRule = showTitle
    ? `.paged-doc .table-of-contents::before {
  content: ${cssString(runtime.tocTitle)};
  display: block;
  font-family: ${cssFontStack(theme.headings.font)};
  font-size: 1.25em;
  font-weight: 700;
  color: var(--doc-heading-color);
  margin-bottom: 0.6em;
}`
    : ''

  // Leader: a flex item with a bottom border. \`none\` skips the rule
  // entirely so the layout collapses to title + (auto-margin) + page
  // number with no line between them.
  const leaderRule = leaderStyle === 'none'
    ? ''
    : `.paged-doc .table-of-contents a::before {
  content: '';
  flex: 1;
  order: 2;
  border-bottom: 1px ${leaderStyle} var(--doc-secondary);
  transform: translateY(-0.25em);
  margin: 0 0.3em;
}`

  // Page numbers via paged.js target-counter. \`margin-left: auto\`
  // pushes the number to the right edge regardless of whether the
  // leader is present: without it, leader=none would leave the
  // page number sitting flush against the title.
  const pageNumberRule = showPageNumbers
    ? `.paged-doc .table-of-contents a::after {
  content: target-counter(attr(href url), page);
  order: 3;
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  color: var(--doc-secondary);
}`
    : ''

  return [
    // Room between the TOC and the first chapter heading.
    `.paged-doc .table-of-contents {
  margin: 1.2em 0 2.2em 0;
  break-inside: avoid;
}`,
    titleRule,
    `.paged-doc .table-of-contents ul {
  list-style: none;
  padding-left: 0;
  margin: 0;
}`,
    `.paged-doc .table-of-contents ul ul {
  padding-left: 1.2em;
  margin: 0;
}`,
    // Spacing on the entry above, not around it: with heading numbers the
    // entries are flex boxes whose margins don't collapse.
    `.paged-doc .table-of-contents li {
  margin: 0;
  break-inside: avoid;
}
.paged-doc .table-of-contents li + li,
.paged-doc .table-of-contents li > ul { margin-top: 0.3em; }`,
    `.paged-doc .table-of-contents a {
  display: flex;
  align-items: baseline;
  gap: 0.4em;
  text-decoration: none;
  color: var(--doc-text);
}`,
    leaderRule,
    pageNumberRule,
    ...depthHide
  ].filter(Boolean).join('\n')
}
