import type { DocTheme } from '../types/theme'
import { resolveHeadingLevel } from '../utils/theme/themeOptions'
import { hrCss } from './blocksCss'
import { cssFontStack } from './cssValues'

// Body text and headings: the modular heading scale, spacing, per-level
// looks, links, lists, footnotes, drop cap.

/**
 * Heading scale. `headings.scale` is the ratio between neighbouring levels
 * from h4 up: h4 = body size (weight carries it), h3 = body·scale,
 * h2 = body·scale², h1 = body·scale³ — 1.73× body at 1.2, 1.95× at 1.25,
 * 2.1× at 1.28, 2.37× at 1.333. h5 = body, h6 = 0.9·body. Display sizes
 * belong to the cover / title block only.
 */
export const HEADING_SCALE_EXPONENTS = [3, 2, 1, 0, 0, 0] as const

/**
 * Space around headings in body lines (body size × line height): more
 * above than below, so a heading sits closer to the text it introduces
 * than to the text before it. `headings.spacingScale` multiplies the
 * space above.
 */
const HEADING_SPACE_ABOVE = [2, 1.6, 1.3, 1.1, 1, 1] as const

const HEADING_SPACE_BELOW = [0.6, 0.5, 0.4, 0.3, 0.3, 0.3] as const

export function headingSizePt(theme: DocTheme, level: number): number {
  const override = resolveHeadingLevel(theme, level).size
  if (override !== null) return theme.body.size * override
  return headingScaleSizePt(theme, level)
}

/** The modular-scale size of a level, ignoring `headings.levels`. */
export function headingScaleSizePt(theme: DocTheme, level: number): number {
  const exp = HEADING_SCALE_EXPONENTS[level - 1] ?? 0
  const factor = level === 6 ? 0.9 : Math.pow(theme.headings.scale, exp)
  return theme.body.size * factor
}

export function typographyBlock(theme: DocTheme): string {
  const bodySize = theme.body.size
  const { font: headingFont, underline, letterSpacing, lineHeight: hLineHeight, spacingScale } = theme.headings
  const headingFamily = cssFontStack(headingFont)
  const linePt = bodySize * theme.body.lineHeight
  const headingRules: string[] = []
  for (let level = 1; level <= 6; level++) {
    const sizePt = headingSizePt(theme, level).toFixed(2)
    const above = ((HEADING_SPACE_ABOVE[level - 1] ?? 1) * linePt * spacingScale).toFixed(2)
    const below = ((HEADING_SPACE_BELOW[level - 1] ?? 0.3) * linePt).toFixed(2)
    // `headings.levels.hN` (h1–h4): size, weight, italic, small caps.
    const look = resolveHeadingLevel(theme, level)
    const lookCss = `${look.style === 'italic' ? '\n  font-style: italic;' : ''}${look.smallCaps ? '\n  font-variant-caps: small-caps;' : ''}${look.align === 'center' ? '\n  text-align: center;' : ''}`
    headingRules.push(`.paged-doc h${level} {
  font-family: ${headingFamily};
  font-size: ${sizePt}pt;
  font-weight: ${look.weight};${lookCss}
  line-height: ${hLineHeight};
  letter-spacing: ${letterSpacing}em;
  color: var(--doc-heading-color);
  margin-top: ${above}pt;
  margin-bottom: ${below}pt;${underline ? `\n  border-bottom: 1px solid var(--doc-brand);\n  padding-bottom: 0.2em;` : ''}
}`)
  }
  // A heading right under another heading needs no full gap above.
  // (Spelled out: paged.js splits selector lists at every comma, so a
  // comma inside `:is()` breaks its querySelectorAll.)
  const stacked = [1, 2, 3, 4, 5, 6].flatMap(a => [2, 3, 4, 5, 6].map(b => `.paged-doc h${a} + h${b}`)).join(', ')
  headingRules.push(`${stacked} { margin-top: ${(0.5 * linePt).toFixed(2)}pt; }`)
  // The first block of every page starts at the top margin (paged.js
  // keeps the margin of the block that opens a page; pagedHandlers.ts
  // marks it).
  headingRules.push(`.paged-doc [data-markoto-page-top] { margin-top: 0 !important; }`)

  // Hyphenation is its own body setting, independent of textAlign.
  // Justified text always needs `text-align-last: left` to prevent the
  // final line stretching; that stays coupled to align.
  const align = theme.body.textAlign
  const hyphensCss = theme.body.hyphenate ? `\n  hyphens: auto;\n  -webkit-hyphens: auto;` : ''
  const lastAlignCss = align === 'justify' ? `\n  text-align-last: left;` : ''
  const justifyExtras = `${hyphensCss}${lastAlignCss}`
  const paragraphMargin = theme.body.paragraphSpacing.toFixed(2)
  // First-line indent: skip the first paragraph (no preceding paragraph
  // visually breaks the flow), indent every paragraph that follows
  // another paragraph. The indent is a typographic 1.2em — enough to
  // see, not so much it reads as a tab.
  const firstLineIndentCss = theme.body.firstLineIndent
    ? `\n.paged-doc > p + p { text-indent: 1.2em; }`
    : ''

  // Drop cap — styled on a `<span class="markoto-dropcap">` injected
  // around the first letter of the first paragraph by
  // `usePagedPreview.wrapFirstLetterAsDropCap`. Lives on a real
  // element rather than `::first-letter` because paged.js's CSSTree
  // preprocessor silently drops pseudo-element rules. Pick the
  // heading FONT but the heading COLOUR so the cap visually anchors
  // the page without slamming the brand red into the body. Disabled
  // entirely when dropCap=false (rule omitted, no CSS noise; the
  // wrapping span isn't injected either).
  const dropCapRule = theme.body.dropCap
    ? `.paged-doc .markoto-dropcap {
  float: left;
  font-family: ${cssFontStack(theme.headings.font)};
  font-size: 3.4em;
  line-height: 0.85;
  margin: 0.05em 0.1em 0 0;
  color: var(--doc-heading-color);
  font-weight: ${theme.headings.weight};
}
.paged-doc .markoto-dropcap-p {
  display: flow-root;
}`
    : ''

  return [
    headingRules.join('\n'),
    // Suppress top margin on the leading element so an opening h1
    // doesn't push whitespace at the top of page 1.
    `.paged-doc > :first-child { margin-top: 0; }`,
    `.paged-doc p { margin: ${paragraphMargin}em 0; orphans: 2; widows: 2; text-align: ${align};${justifyExtras} }${firstLineIndentCss}`,
    // Per-block alignment overrides via `@mdit/plugin-attrs`. Source:
    //   This paragraph is centered.
    //   {.text-center}
    // Higher specificity than the doc-level `.paged-doc p` rule because
    // class beats element, so attribute-tagged blocks override the
    // theme-wide alignment without `!important`. Targets paragraphs,
    // headings, blockquotes, list items, and figcaptions — anywhere
    // an attribute can land.
    `.paged-doc .text-left { text-align: left; text-align-last: left; }`,
    `.paged-doc .text-center { text-align: center; text-align-last: center; }`,
    `.paged-doc .text-right { text-align: right; text-align-last: right; }`,
    `.paged-doc .text-justify { text-align: justify; text-align-last: left; hyphens: auto; -webkit-hyphens: auto; }`,
    `.paged-doc strong { font-weight: 700; }`,
    `.paged-doc em { font-style: italic; }`,
    `.paged-doc ins { text-decoration: underline; }`,
    `.paged-doc mark { background: color-mix(in srgb, var(--doc-brand) 25%, transparent); padding: 0 0.1em; }`,
    `.paged-doc a {
  color: var(--doc-brand);
  text-decoration: underline;
}`,
    `.paged-doc ul { list-style-type: disc; padding-left: 1.4em; margin: 0.5em 0; }`,
    `.paged-doc ol { list-style-type: decimal; padding-left: 1.4em; margin: 0.5em 0; }`,
    `.paged-doc li { margin: 0.2em 0; }`,
    `.paged-doc li.task-list-item { list-style-type: none; margin-left: -1.2em; }`,
    `.paged-doc li.task-list-item input[type="checkbox"] { margin-right: 0.4em; }`,
    `.paged-doc dl { margin: 0.8em 0; }`,
    `.paged-doc dt { font-weight: 600; margin-top: 0.5em; }`,
    `.paged-doc dd { margin: 0.2em 0 0.4em 1.4em; }`,
    `.paged-doc abbr { text-decoration: underline dotted; cursor: help; }`,
    `.paged-doc figure { margin: 1em 0; text-align: center; }`,
    // An image without alt text gets an empty <figcaption> from the figure plugin.
    `.paged-doc figcaption:empty { display: none; }`,
    `.paged-doc figcaption { font-family: ${cssFontStack(theme.meta.font)}; font-size: 0.85em; color: var(--doc-secondary); margin-top: 0.4em; font-style: italic; }`,
    hrCss(theme),
    // Footnote support — see `transformFootnotesForPagedMedia` in
    // app/utils/markdown/renderMarkdown.ts.
    // Footnotes are text: body font, 0.8 × body size (set on @footnote too).
    `.paged-doc .footnote { float: footnote; font-family: ${cssFontStack(theme.body.font)}; font-size: ${(theme.body.size * 0.8).toFixed(2)}pt; line-height: 1.35; font-style: normal; font-weight: normal; }`,
    `.paged-doc ::footnote-call { content: counter(footnote); vertical-align: super; font-size: 0.7em; color: var(--doc-brand); line-height: 0; }`,
    `.paged-doc ::footnote-marker { content: counter(footnote) ". "; color: var(--doc-brand); }`,
    dropCapRule
  ].filter(Boolean).join('\n')
}
