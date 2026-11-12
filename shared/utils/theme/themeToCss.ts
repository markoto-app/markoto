import type { DocTheme, RunningSlots, HeadingNumbering } from '../../types/theme'
import { pageHeightMm } from './pageDimensions'
import type { CustomCssResult } from '../../types/customCss'
import { isThemeImageUrl } from './themeImages'
import { fontStylesheetUrls } from './themeFonts'
import { coverTitleWeight, headingNumbering, mirrorMargins, numberingDepth, referenceStyle, repeatTitle, resolveCaptions, resolveChapterLabel, resolveCodeOptions, resolveHeadingLevel, resolvePageMargins, resolveSectionToken, resolveTitleBlock, runningRule } from './themeOptions'
import { HLJS_THEME_COLORS } from '../vendor/hljsAssets'

/**
 * Runtime values interpolated into the theme CSS. Kept separate from
 * the theme itself because they change at a different cadence (title
 * on rename, date once per render) and because baking them into the
 * CSS string is simpler than the CSS-custom-property dance — paged.js
 * extracts header/footer content into margin boxes that are NOT
 * descendants of `.paged-doc`, so vars set there don't propagate.
 */
export type ThemeRuntime = {
  title: string
  /** Publication date as shown (`documentTexts().date`), for `{date}`. */
  date: string
  // Localized text rendered by CSS \`content:\` for the optional TOC
  // heading. Lives in runtime (not the theme) because i18n strings
  // shouldn't be persisted to the doc — same translation should apply
  // when the doc opens in another language.
  tocTitle: string
  /**
   * Caption labels in the document language (`documentTexts().captionLabels`)
   * for `tables.captionLabel` / `blocks.figureLabel`. Absent = English.
   */
  captionLabels?: { table: string, figure: string, separator: string, chapter?: { before: string, after: string } }
  /**
   * The document's custom CSS AFTER `sanitizeCustomCss` (shared/utils/theme/customCss.ts).
   * Appended last so user rules override the theme. Typed as the
   * sanitizer's result (not a bare string) so a call site can't hand the
   * raw `theme.customCss` through by accident — `theme.customCss` itself
   * is never read here.
   */
  customCss?: CustomCssResult
  /**
   * Maps a header/footer image URL (already shape-checked, see
   * `shared/utils/theme/themeImages.ts`) to the URL the page actually loads.
   * The server render page uses it to add its file-access token to this
   * document's own uploads; everyone else loads the URL as stored.
   */
  imageUrl?: (url: string) => string
}

/**
 * Compile a DocTheme into a single CSS stylesheet that drives both the
 * live paged preview and the PDF print iframe.
 */
export function themeToCss(theme: DocTheme, runtime: ThemeRuntime): string {
  const blocks = [
    pageBlock(theme, runtime),
    rootBlock(theme),
    typographyBlock(theme),
    tableBlock(theme),
    blockBlock(theme),
    codeBlock(theme),
    alertBlock(theme),
    katexBlock(theme),
    mermaidBlock(theme),
    tocBlock(theme, runtime),
    numberingBlock(theme, runtime),
    captionBlock(theme, runtime),
    referencesBlock(theme),
    sectionStringBlock(theme),
    runningRuleBlock(theme),
    pageBreakBlock(),
    columnSpanBlock(theme),
    coverBlock(theme),
    repeatTitleBlock(theme),
    breakHints(theme.layout.columns)
  ]
  const custom = runtime.customCss?.css
  if (custom) blocks.push(`/* custom css */\n${custom}`)
  return blocks.join('\n\n')
}

/**
 * `@import` rules for the theme's fonts — one same-origin stylesheet per
 * self-hosted family (shared/utils/theme/themeFonts.ts); a family we don't
 * serve is skipped and renders in the fallback stack. Returned separately
 * so changing a color doesn't trigger a font refetch. The stylesheets
 * only declare @font-face rules: a browser downloads just the weights,
 * styles and unicode-range subsets the document actually uses.
 */
export function themeFontsImport(theme: DocTheme): string {
  return fontStylesheetUrls([theme.body.font, theme.headings.font, theme.meta.font, resolveCodeOptions(theme).font])
    .map(url => `@import url('${url}');`)
    .join('\n')
}

// Page block

function pageBlock(theme: DocTheme, runtime: ThemeRuntime): string {
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

type RunningSlotPosition = 'left' | 'center' | 'right'

function renderMarginBoxes(theme: DocTheme, slots: RunningSlots, edge: 'top' | 'bottom', runtime: ThemeRuntime, textColor: string, metaFont: string, marginMm: number): string {
  // The optional image (if `imageUrl` is set) wins over text in the slot
  // it lands in — same slot can't show both. Users typically pick one
  // mental model per slot anyway. paged.js margin boxes accept
  // `content: url('...')` per CSS Paged Media; the image inherits the
  // slot's vertical alignment from the @top-X box itself.
  // Only an upload path / bundled asset is emitted (the theme can reach
  // here over Y.js without validation); anything else drops the image.
  const imgSlot = slots.imageUrl && isThemeImageUrl(slots.imageUrl) ? slots.imagePosition : null
  const text: Record<RunningSlotPosition, string> = {
    left: slots.left,
    center: slots.center,
    right: slots.right
  }
  const positions = ['left', 'center', 'right'] as const
  const out: string[] = []
  // With a rule the running text sits next to the text block, the rule
  // between them (see runningRuleBlock): bottom of the header box / top
  // of the footer box, padded past the rule.
  const ruleAlign = runningRule(slots)
    ? edge === 'top'
      ? `
    vertical-align: bottom;
    padding-bottom: ${(runningRuleGapPt(marginMm) + RUNNING_RULE_TEXT_GAP_PT).toFixed(2)}pt;`
      : `
    vertical-align: top;
    padding-top: ${(runningRuleGapPt(marginMm) + RUNNING_RULE_TEXT_GAP_PT).toFixed(2)}pt;`
    : ''
  for (const pos of positions) {
    const boxName = `${edge}-${pos}`
    if (imgSlot === pos) {
      // Image slot — URL serialised as a CSS string (shape-checked
      // above, so this is belt and braces); height pinned in pt so it
      // lines up with the running header's text-size scale.
      const src = runtime.imageUrl ? runtime.imageUrl(slots.imageUrl) : slots.imageUrl
      out.push(`  @${boxName} {
    content: url(${cssString(src)});
    height: ${slots.imageHeight}pt;
    width: auto;${ruleAlign}
  }`)
      continue
    }
    const tpl = text[pos].trim()
    if (!tpl) continue
    out.push(`  @${boxName} {
    content: ${compileTemplate(tpl, theme, runtime)};
    font-family: ${cssFontStack(metaFont)};
    font-size: 9pt;
    color: ${textColor};
    opacity: 0.7;${ruleAlign}
  }`)
  }
  return out.join('\n')
}

/**
 * `header.rule` / `footer.rule`: the distance between the rule and the
 * text block — 0.35 × the page margin (25 pt at a 1in margin, LaTeX's
 * `headsep` in the arXiv style). The running text sits on the far side
 * of the rule, RUNNING_RULE_TEXT_GAP_PT past it (descenders just clear
 * the rule, as fancyhdr draws it).
 */
export function runningRuleGapPt(marginMm: number): number {
  return marginMm * MM_TO_PT * 0.35
}
const MM_TO_PT = 72 / 25.4
const RUNNING_RULE_TEXT_GAP_PT = 2
const RUNNING_RULE_WIDTH_PT = 0.4

/**
 * The running rule spans the whole text width (all three slots), so it
 * is painted on paged.js's margin ROW (`.pagedjs_margin-top` /
 * `-bottom`, exactly as wide as the text block) — not on a slot box,
 * which would underline only that slot, and not as a border at the row's
 * edge, which sits a whole margin away from the text. Only for an edge
 * that has running text; never on the first page when the theme has a
 * cover page or title block (both clear the running text there). Works
 * the same in the preview, browser print and the server PDF: they all
 * run paged.js.
 */
function runningRuleBlock(theme: DocTheme): string {
  const color = theme.body.color
  const margins = resolvePageMargins(theme)
  const page = theme.cover.enabled ? '.pagedjs_page:not(.pagedjs_first_page)' : '.pagedjs_page'
  const rules: string[] = []
  const edges = [['top', theme.header, 'bottom', margins.top], ['bottom', theme.footer, 'top', margins.bottom]] as const
  for (const [edge, slots, side, marginMm] of edges) {
    if (!runningRule(slots) || !hasRunningContent(slots)) continue
    const gap = runningRuleGapPt(marginMm).toFixed(2)
    rules.push(`${page} .pagedjs_margin-${edge} {
  background: linear-gradient(${color}, ${color}) left 0 ${side} ${gap}pt / 100% ${RUNNING_RULE_WIDTH_PT}pt no-repeat;
}`)
  }
  return rules.join('\n')
}

function hasRunningContent(slots: RunningSlots): boolean {
  const image = slots.imageUrl !== '' && isThemeImageUrl(slots.imageUrl)
  return image || [slots.left, slots.center, slots.right].some(t => t.trim() !== '')
}

function compileTemplate(template: string, theme: DocTheme, runtime: ThemeRuntime): string {
  const parts: string[] = []
  const regex = /\{(title|section|author|page|pages|date)\}/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(template)) !== null) {
    if (match.index > lastIndex) {
      parts.push(cssString(template.slice(lastIndex, match.index)))
    }
    parts.push(tokenToCss(match[1] ?? '', theme, runtime))
    lastIndex = regex.lastIndex
  }
  if (lastIndex < template.length) {
    parts.push(cssString(template.slice(lastIndex)))
  }
  return parts.length ? parts.join(' ') : '""'
}

function tokenToCss(token: string, theme: DocTheme, runtime: ThemeRuntime): string {
  switch (token) {
    case 'title': return cssString(runtime.title)
    // The current section heading (sectionStringBlock): the first on the
    // page, or with `header.sectionMode: 'start'` the one the page starts in.
    case 'section': return resolveSectionToken(theme).mode === 'start' ? `string(${SECTION_STRING}, start)` : `string(${SECTION_STRING})`
    case 'author': return cssString(theme.cover.authors.map(a => a.trim()).filter(Boolean).join(', '))
    case 'page': return 'counter(page)'
    case 'pages': return 'counter(pages)'
    case 'date': return cssString(runtime.date)
    default: return '""'
  }
}

// Root block

function columnRules(columns: number, columnGap: number): string {
  if (columns <= 1) return ''
  return `  column-count: ${columns};\n  column-gap: ${columnGap}mm;\n  column-fill: auto;`
}

function rootBlock(theme: DocTheme): string {
  const { brand, secondary } = theme.color
  const { color: text, background, font, size, lineHeight } = theme.body
  const { columns, columnGap } = theme.layout
  return `.paged-doc {
  --doc-brand: ${brand};
  --doc-secondary: ${secondary};
  --doc-text: ${text};
  --doc-bg: ${background};
  --doc-heading-color: ${theme.headings.color};
${fontVars(theme)}
  font-family: ${cssFontStack(font)};
  font-size: ${size}pt;
  line-height: ${lineHeight};
  color: var(--doc-text);
  background: var(--doc-bg);
${columnRules(columns, columnGap)}
}

/* Paint the entire paged.js page surface in the theme's paper colour
   (not just the inner content rectangle). Without this, cream/beige
   themes only colour the content area while the page sheet underneath
   stays white — visually breaks the "warm paper" effect. \`!important\`
   because paged.js injects its own stylesheet AFTER ours and paints
   a white sheet by default. Scoped to .pagedjs_page only — leaving
   .pagedjs_pagebox alone — to avoid recursing into paged.js's
   internal margin-box layout (which can hang the chunker). */
.pagedjs_page {
  background: ${background} !important;
}

/* The same variables for the margin boxes (running head / foot), which
   are not inside .paged-doc. */
.pagedjs_page {
  --doc-brand: ${brand};
  --doc-secondary: ${secondary};
  --doc-text: ${text};
${fontVars(theme)}
}`
}

/**
 * The author's font + accent choices as custom properties, so template CSS
 * (\`theme.customCss\`) follows them instead of naming a family:
 * \`font-family: var(--doc-heading-font)\`. Documented in
 * docs/contributing/TEMPLATE-WORKFLOW.md.
 */
function fontVars(theme: DocTheme): string {
  return [
    `  --doc-accent: ${theme.color.brand};`,
    `  --doc-body-font: ${cssFontStack(theme.body.font)};`,
    `  --doc-heading-font: ${cssFontStack(theme.headings.font)};`,
    `  --doc-meta-font: ${cssFontStack(theme.meta.font)};`,
    `  --doc-mono-font: ${codeFontStack(theme)};`
  ].join('\n')
}

// Typography

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

function typographyBlock(theme: DocTheme): string {
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

// Tables

function tableBlock(theme: DocTheme): string {
  const { headerBackground, headerTextColor, borders, zebra, cellPadding } = theme.tables

  // Border CSS varies by setting:
  //   all        — border on every cell (the default GFM look)
  //   horizontal — only between rows (newspaper / report style)
  //   minimal    — only at table top + bottom + below header
  //   none       — no borders at all
  let borderRules = ''
  switch (borders) {
    case 'all':
      borderRules = `.paged-doc th, .paged-doc td { border: 1px solid var(--doc-text); }`
      break
    case 'horizontal':
      borderRules = `.paged-doc tr { border-bottom: 1px solid var(--doc-secondary); }
.paged-doc tbody tr:last-child { border-bottom: none; }`
      break
    case 'minimal':
      borderRules = `.paged-doc table { border-top: 2px solid var(--doc-text); border-bottom: 2px solid var(--doc-text); }
.paged-doc thead { border-bottom: 1px solid var(--doc-text); }`
      break
    case 'none':
      // initial `let borderRules = ''` already covers this branch
      break
  }

  // Header background:
  //   brand  — full brand color (caller picks header text color)
  //   muted  — subtle tint of body text color
  //   none   — transparent (no fill)
  let headerBg = ''
  switch (headerBackground) {
    case 'brand':
      headerBg = `background: var(--doc-brand);`
      break
    case 'muted':
      headerBg = `background: color-mix(in srgb, var(--doc-text) 6%, transparent);`
      break
    case 'none':
      // initial `let headerBg = ''` already covers this branch
      break
  }

  // Header text color:
  //   auto   — pick contrasting text against the bg (white on brand,
  //            inherit on muted/none)
  //   inherit — body color regardless
  let headerColor = ''
  if (headerTextColor === 'auto' && headerBackground === 'brand') {
    headerColor = 'color: white;'
  }

  const zebraRule = zebra
    ? `.paged-doc tbody tr:nth-child(even) { background: color-mix(in srgb, var(--doc-text) 4%, transparent); }`
    : ''

  return [
    `.paged-doc table {
  border-collapse: collapse;
  width: 100%;
  margin: 1em 0;
}`,
    `.paged-doc th, .paged-doc td {
  padding: ${cellPadding}px ${Math.round(cellPadding * 1.5)}px;
  text-align: left;
  vertical-align: top;
  overflow-wrap: break-word;
  hyphens: auto;
}`,
    // Wide tables fit the text width instead of running off the page: words
    // hyphenate, code in a cell (long identifiers, package names) may break
    // anywhere — that keeps a column's minimum width small without cutting
    // ordinary words apart — and tables with many columns get a smaller
    // type size (one selector each — paged.js splits selector lists).
    `.paged-doc td code { overflow-wrap: anywhere; }`,
    // A number and its unit, a currency and its amount, and short codes
    // like SEV-1 never part (renderMarkdown wraps them in table cells).
    `.paged-doc .markoto-nowrap { white-space: nowrap; }`,
    `.paged-doc th code { overflow-wrap: anywhere; }`,
    // How wide a table is with nothing broken apart: the pagination
    // handler sets this attribute for one measurement in a multi-column
    // page and lets a table that needs more than a column span the page.
    `.paged-doc table[data-markoto-measure] td, .paged-doc table[data-markoto-measure] th, .paged-doc table[data-markoto-measure] code, .paged-doc table[data-markoto-measure] .markoto-code-token { overflow-wrap: normal !important; word-break: normal !important; max-width: none !important; }`,
    `.paged-doc table:has(tr > :nth-child(8)) { font-size: 0.88em; }`,
    `.paged-doc table:has(tr > :nth-child(10)) { font-size: 0.8em; }`,
    `.paged-doc th {
  font-weight: 600;
  ${headerBg}
  ${headerColor}
}`,
    borderRules,
    zebraRule
  ].filter(Boolean).join('\n')
}

// Blocks (images / blockquote)

function blockBlock(theme: DocTheme): string {
  const { imageRadius, imageMaxWidth, blockquoteStyle } = theme.blocks
  return [
    `.paged-doc img {
  max-width: ${imageMaxWidth}%;
  height: auto;
  border-radius: ${imageRadius}px;
  margin: 0.8em 0;
}`,
    blockquoteCss(blockquoteStyle)
  ].join('\n')
}

function hrCss(theme: DocTheme): string {
  const { hrStyle, hrThickness } = theme.blocks
  switch (hrStyle) {
    case 'none':
      // No visible separator, but reserve a margin so the source
      // `---` still creates a visual breath in the page.
      return `.paged-doc hr { border: none; margin: 1.5em 0; height: 0; }`
    case 'asterism':
      // Editorial signature — the Unicode asterism (⁂) centered with
      // generous breathing room. Reads like a Penguin Classics scene
      // break. We sneak it in via ::before because <hr> is a void
      // element and can't have text children directly.
      return `.paged-doc hr { border: none; text-align: center; margin: 2em 0; height: 1em; line-height: 1; }
.paged-doc hr::before { content: '⁂'; color: var(--doc-secondary); font-size: 1.4em; letter-spacing: 0.4em; }`
    case 'dashed':
      return `.paged-doc hr { border: none; border-top: ${hrThickness}px dashed var(--doc-secondary); margin: 1.5em 0; }`
    case 'dotted':
      return `.paged-doc hr { border: none; border-top: ${hrThickness}px dotted var(--doc-secondary); margin: 1.5em 0; }`
    case 'rule':
    default:
      return `.paged-doc hr { border: none; border-top: ${hrThickness}px solid var(--doc-secondary); margin: 1.5em 0; }`
  }
}

function blockquoteCss(variant: DocTheme['blocks']['blockquoteStyle']): string {
  if (variant === 'none') {
    return `.paged-doc blockquote { font-style: italic; margin: 1em 0; padding: 0; }`
  }
  if (variant === 'background') {
    return `.paged-doc blockquote {
  background: color-mix(in srgb, var(--doc-brand) 8%, transparent);
  padding: 0.8em 1em;
  margin: 1em 0;
  border-radius: 4px;
}`
  }
  return `.paged-doc blockquote {
  border-left: 3px solid var(--doc-brand);
  padding-left: 1em;
  margin: 1em 0;
  font-style: italic;
  color: color-mix(in srgb, var(--doc-text) 75%, var(--doc-bg));
}`
}

// Code

const SYSTEM_MONO_STACK = `ui-monospace, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace`

function codeFontStack(theme: DocTheme): string {
  const font = resolveCodeOptions(theme).font
  if (!font) return SYSTEM_MONO_STACK
  const escaped = font.replaceAll('"', String.raw`\"`)
  return `"${escaped}", ${SYSTEM_MONO_STACK}`
}

/**
 * Blocks of at most this many lines are kept on one page; longer ones
 * split between lines. `renderMarkdown` wraps every code line in a
 * `<span class="code-line">`, so the count is a selector.
 */
const CODE_KEEP_TOGETHER_LINES = 15

/**
 * Code blocks: one box for every highlight theme. The `<pre>` carries the
 * fill, frame, padding and radius; the highlight.js stylesheet only
 * colours tokens (its own `.hljs` padding/background/overflow are
 * neutralised). Fill (`code.background`): dark highlight themes always
 * keep their own background (their token colours need it); light ones
 * use their background when it isn't white (solarized), else a faint
 * tint of the text colour, so a block never floats bare on the page.
 * Frame (`code.frame`): an accent rule on the left or a hairline box.
 * Long lines wrap (`code.wrap`, default on — a page can't scroll). Line numbers
 * (`code.lineNumbers`) come from each line's `data-line`. A fence title
 * (```ts title="replay.ts") renders as a caption bar above the block.
 */
function codeBlock(theme: DocTheme): string {
  const monoStack = codeFontStack(theme)
  const { theme: codeTheme, fontSize } = theme.code
  const opts = resolveCodeOptions(theme)
  const colors = codeTheme === 'none' ? null : HLJS_THEME_COLORS[codeTheme]
  const tint = 'color-mix(in srgb, var(--doc-text) 5%, var(--doc-bg))'
  let fill: string
  let ink = 'inherit'
  if (colors?.dark) {
    fill = colors.background
    ink = colors.color
  } else if (opts.background === 'none') {
    fill = 'transparent'
  } else if (opts.background === 'tint' || !colors || colors.background === '#ffffff') {
    fill = tint
  } else {
    fill = colors.background
  }
  const filled = fill !== 'transparent'
  const radius = Math.min(6, Math.max(2, theme.blocks.imageRadius))
  const frameCss = opts.frame === 'rule'
    ? `\n  border-left: 3px solid var(--doc-brand);\n  border-radius: 0 ${radius}px ${radius}px 0;`
    : opts.frame === 'box'
      ? `\n  border: 0.75pt solid color-mix(in srgb, var(--doc-secondary) 70%, transparent);\n  border-radius: ${radius}px;`
      : `\n  border-radius: ${filled ? radius : 0}px;`
  const padX = filled || opts.frame !== 'none' ? '0.9em' : '0'
  const gutter = opts.lineNumbers ? '3.2em' : padX
  const whiteSpace = opts.wrap
    ? 'white-space: pre-wrap;\n  overflow-wrap: anywhere;'
    : 'white-space: pre;\n  overflow: hidden;'

  return [
    // Code is literal: no ligatures. Programming fonts (JetBrains Mono)
    // draw `|=` as a turnstile, `!=` as ≠, `->` as an arrow, and the
    // printed page must show what is typed. `none` also turns off the
    // contextual alternates (`calt`) those ligatures live in.
    `.paged-doc code, .paged-doc pre, .paged-doc .code-title { font-variant-ligatures: none; }`,
    // Inline code wraps between its words, never inside one
    // (renderMarkdown wraps each space-separated token): `--data-urlencode`
    // doesn't break after a hyphen. A token wider than the line still
    // breaks rather than running off the page.
    `.paged-doc .markoto-code-token { display: inline-block; max-width: 100%; overflow-wrap: anywhere; text-indent: 0; }`,
    // Inline code is always lightly tinted regardless of code theme — it
    // sits inline with body text and shouldn't pull a heavy fill.
    `.paged-doc :not(pre) > code {
  font-family: ${monoStack};
  font-size: 0.88em;
  padding: 0.1em 0.35em;
  border-radius: 3px;
  background: color-mix(in srgb, var(--doc-text) 8%, transparent);
}`,
    `.paged-doc pre {
  font-family: ${monoStack};
  font-size: ${fontSize}pt;
  line-height: 1.45;
  margin: 1em 0;
  padding: ${filled || opts.frame !== 'none' ? '0.75em' : '0.25em'} ${padX} ${filled || opts.frame !== 'none' ? '0.75em' : '0.25em'} ${gutter};
  background: ${fill};
  color: ${ink};${frameCss}
  ${whiteSpace}
  box-sizing: border-box;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}`,
    `.paged-doc pre code,
.paged-doc pre code.hljs {
  display: block;
  font-family: inherit;
  font-size: inherit;
  background: transparent;
  padding: 0;
  overflow: visible;
  white-space: inherit;
  overflow-wrap: inherit;${codeTheme === 'none' ? '\n  color: inherit;' : ''}
}`,
    // One block per line (renderMarkdown#wrapCodeLines drops the "\n"s);
    // an empty line keeps its height.
    `.paged-doc pre .code-line { display: block; min-height: 1.45em; }`,
    opts.lineNumbers
      ? `.paged-doc pre .code-line::before {
  content: attr(data-line);
  display: inline-block;
  width: 2.4em;
  margin-left: -3em;
  margin-right: 0.6em;
  text-align: right;
  color: color-mix(in srgb, currentColor 45%, transparent);
  font-variant-numeric: tabular-nums;
  user-select: none;
}`
      : '',
    // Caption from the fence's `title="…"`: a small bar glued to the block.
    `.paged-doc .code-block { margin: 1em 0; }
.paged-doc .code-block > pre { margin-top: 0; }
.paged-doc .code-title {
  font-family: ${monoStack};
  font-size: ${Math.max(6, fontSize - 1)}pt;
  color: var(--doc-secondary);
  padding: 0.35em ${padX === '0' ? '0' : '0.9em'};
  border-bottom: 0.75pt solid ${colors?.dark ? `color-mix(in srgb, ${fill} 70%, #ffffff)` : 'color-mix(in srgb, var(--doc-secondary) 45%, transparent)'};
  background: ${filled ? (colors?.dark ? `color-mix(in srgb, ${fill} 88%, #ffffff)` : fill) : 'transparent'};${colors?.dark ? `\n  color: color-mix(in srgb, ${ink} 75%, ${fill});` : ''}
  border-radius: ${filled || opts.frame === 'box' ? `${radius}px ${radius}px 0 0` : '0'};
  break-after: avoid;
}
.paged-doc .code-title + pre { border-top-left-radius: 0; border-top-right-radius: 0; }`
  ].filter(Boolean).join('\n')
}

// Alerts (GitHub-style admonitions)

/**
 * GitHub-style alert blocks emitted by `@mdit/plugin-alert`. Five kinds,
 * each in its own semantic color so the meaning reads at a glance. The
 * palette comes from `theme.alerts.{note|tip|important|warning|caution}`,
 * so each preset sets its own admonition look instead of a fixed
 * blue/green/purple scheme.
 *
 * HTML structure (from the plugin):
 *   <div class="markdown-alert markdown-alert-{kind}">
 *     <p class="markdown-alert-title">Note</p>
 *     <p>...body...</p>
 *   </div>
 */
function alertBlock(theme: DocTheme): string {
  const { alerts } = theme
  const kinds: Array<{ name: string, color: string }> = [
    { name: 'note', color: alerts.note },
    { name: 'tip', color: alerts.tip },
    { name: 'important', color: alerts.important },
    { name: 'warning', color: alerts.warning },
    { name: 'caution', color: alerts.caution }
  ]
  const variants = kinds.map(k => `.paged-doc .markdown-alert-${k.name} {
  border-left-color: ${k.color};
  background: color-mix(in srgb, ${k.color} 8%, transparent);
}
.paged-doc .markdown-alert-${k.name} .markdown-alert-title {
  color: ${k.color};
}`).join('\n')
  return [
    `.paged-doc .markdown-alert {
  border-left: 4px solid;
  padding: 0.6em 1em;
  margin: 1em 0;
  border-radius: 4px;
  break-inside: avoid;
}`,
    `.paged-doc .markdown-alert > :first-child { margin-top: 0; }`,
    `.paged-doc .markdown-alert > :last-child { margin-bottom: 0; }`,
    `.paged-doc .markdown-alert-title {
  font-weight: 600;
  font-size: 0.9em;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 0 0 0.4em 0;
}`,
    variants
  ].join('\n')
}

// KaTeX math

/**
 * Body fonts whose x-height is no larger than KaTeX's Computer Modern
 * (0.431 em) plus 5 %: inline math is set at the text size next to them.
 * Measured from the bundled / self-hosted files (x-height / em):
 * Latin Modern Roman 0.431 (the same design as KaTeX's), TeX Gyre Termes
 * 0.450, Crimson Text 0.424, EB Garamond 0.405, Cormorant Garamond 0.386.
 * Every other registered text face has an x-height of 0.47–0.56 em, so
 * math there gets a small step up (1.05 em) to sit level with the text.
 */
const SMALL_X_HEIGHT_FONTS: ReadonlySet<string> = new Set([
  'latin modern roman', 'tex gyre termes', 'crimson text', 'eb garamond', 'cormorant garamond'
])

/** Size of KaTeX math (inline and display) relative to the body text, in em. */
export function mathFontScale(bodyFont: string): number {
  return SMALL_X_HEIGHT_FONTS.has(bodyFont.trim().toLowerCase()) ? 1 : 1.05
}

/**
 * Layout-only adjustments around `@mdit/plugin-katex` output. Glyph
 * positioning and font selection come from the KaTeX stylesheet (loaded
 * from /vendor/ inside the iframe). What remains here is print-context hygiene:
 * block math gets a vertical breathing room and doesn't break across pages.
 *
 * A display wider than the text column wraps instead of being cut off:
 * KaTeX already splits a formula into one box per stretch between the
 * places TeX allows a break (after a relation or a binary operator on
 * the outer level, TeXbook p. 173 — `=`, `+`, `\le` …), and only its
 * `white-space: nowrap` on display math keeps those boxes on one line.
 * Allowing the wrap continues a long equation on the next line. The
 * pagination handler (`pagedHandlers.ts`, display math) turns that into
 * TeX's display convention: the break comes BEFORE the relation or
 * operator, relations first, and the continuation lines hang at the first
 * relation, the block of lines centred. A single unbreakable piece wider
 * than the column — a huge fraction or matrix — shrinks to 85 % at most;
 * still too wide, it spans a multi-column page or runs into the margin
 * (never clipped, as `overflow-x: auto` did on paper).
 *
 * KaTeX lays a formula out with nested inline tables whose rows are
 * centred by `text-align` — but inherited text properties of the
 * surrounding paragraph leak in. A justified paragraph's
 * `text-align-last: left` made every single-line row start-aligned:
 * accents (`\hat{\lambda}`) slid off their base, fraction numerators and
 * limits left-aligned, display equations hugged the left margin. The
 * reset below hands KaTeX back its own alignment and spacing, whatever
 * the theme or template CSS sets on the text around it.
 */
function katexBlock(theme: DocTheme): string {
  return [
    `.paged-doc .katex-display {
  margin: 1em 0;
  break-inside: avoid;
}`,
    `.paged-doc .katex-display > .katex { white-space: normal; }`,
    // The pagination handler gives a wrapped display a hanging indent
    // (`text-indent` on `.katex-html`); KaTeX's boxes must not inherit it.
    `.paged-doc .katex-display .katex-html > *, .paged-doc .katex-display .katex-base { text-indent: 0; }`,
    `.paged-doc .katex { font-size: ${mathFontScale(theme.body.font)}em; }`,
    `.paged-doc .katex { text-align-last: auto; letter-spacing: normal; word-spacing: normal; text-transform: none; font-variant: normal; font-feature-settings: normal; hyphens: manual; -webkit-hyphens: manual; }`
  ].join('\n')
}

// Mermaid diagrams

/**
 * Mermaid diagrams arrive as `<div class="mermaid"><img data:svg></div>`
 * (atomic for paged.js) and are swapped for the inline SVG after
 * pagination (so their text uses the page's web fonts — see
 * app/utils/markdown/mermaidLoader.ts). Both forms share one sizing rule, so the
 * swap never moves anything: natural size, never wider than the column
 * and never taller than ~45% of the text area — a chart must not eat a
 * whole page. Colours + fonts come from `buildMermaidConfig(theme)`.
 */
function mermaidBlock(theme: DocTheme): string {
  const margins = resolvePageMargins(theme)
  const textHeightMm = pageHeightMm(theme.page.size, theme.page.orientation) - margins.top - margins.bottom
  const maxHeightMm = Math.max(40, Math.round(textHeightMm * 0.45))
  return [
    `.paged-doc .mermaid {
  margin: 1em auto;
  text-align: center;
  break-inside: avoid;
}`,
    `.paged-doc .mermaid > img,
.paged-doc .mermaid > svg {
  display: block;
  margin: 0 auto;
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: ${maxHeightMm}mm;
  /* Labels mermaid measured a touch short must not be clipped at the
     SVG viewport. */
  overflow: visible;
}`,
    // Mermaid draws pies 450px tall whatever their content; shown at full
    // size a five-slice pie took half a page. Its labels are set larger
    // to match (mermaidConfig.ts), so they stay legible at this size.
    `.paged-doc .mermaid-pie > img,
.paged-doc .mermaid-pie > svg {
  max-height: ${Math.min(maxHeightMm, 85)}mm;
}`,
    // Sequence diagrams and gantt charts are drawn one text column wide
    // with their labels at the body size (mermaidConfig.ts); a long one
    // capped at the general height scaled its text back down to ~6pt.
    `.paged-doc .mermaid-sequence > img,
.paged-doc .mermaid-sequence > svg,
.paged-doc .mermaid-gantt > img,
.paged-doc .mermaid-gantt > svg {
  max-height: ${Math.max(maxHeightMm, Math.round(textHeightMm * 0.85))}mm;
}`,
    `.paged-doc .mermaid-error {
  margin: 1em 0;
  padding: 0.6em 1em;
  border-left: 4px solid #cf222e;
  background: color-mix(in srgb, #cf222e 8%, transparent);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.85em;
  color: #cf222e;
}`
  ].join('\n')
}

// Table of contents

/**
 * Auto-generated TOC from \`[[toc]]\` (markdown-it-toc-done-right). Plays
 * to paged.js's killer feature: \`target-counter(attr(href url), page)\`
 * resolves the page number of each TOC link's target heading at print
 * time. The result reads like a real book TOC — heading title on the
 * left, dotted leader, page number on the right.
 *
 * Indentation is by nested \`<ul>\` levels; the renderer emits up to h4.
 * Resetting list-style hides the bullets (typographers don't put
 * bullets next to TOC entries — the dotted leader carries the eye).
 */
function tocBlock(theme: DocTheme, runtime: ThemeRuntime): string {
  const { maxDepth, showTitle, showPageNumbers, leaderStyle } = theme.toc

  // Renderer always emits up to h4 (4 nested ULs in worst case).
  // `composeFinalHtml` removes the levels beyond maxDepth (pruneTocDepth —
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
  // [[toc]]). Title text comes through runtime so it can be localized
  // — themeToCss bakes it into the CSS string at render time.
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
  // leader is present — without it, leader=none would leave the
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

// Heading numbers

/**
 * Headings that never get a number (nor advance the counters): the cover /
 * title-block title, the abstract, and headings the author marked
 * `{.unnumbered}` / `{-}` (Pandoc convention — References, Acknowledgements).
 */
const UNNUMBERED = ':not(.markoto-cover-title):not(.markoto-abstract-heading):not(.unnumbered)'
/** TOC entries of those headings (marked by `app/utils/preview/titleBlock.ts`). */
const UNNUMBERED_TOC = ':not(.markoto-abstract-entry):not(.markoto-unnumbered-entry)'

/**
 * Heading numbers (`headings.numbering`) before h1–h4 and before the
 * matching TOC entries. Plain CSS counters: paged.js turns
 * `counter-increment` / `counter-reset` into per-element values, so
 * numbers continue across pages. h1 resets the levels below it and
 * nothing above. The TOC lists the same headings in the same order (the
 * abstract's and `{.unnumbered}` headings' entries are marked by
 * `markAbstract` / `markUnnumbered` and skipped), so its counters match
 * the headings'.
 *
 * Levels count from the highest heading level the document numbers: when
 * that is h2 (no h1), `composeFinalHtml` marks the numbered headings
 * `markoto-num-from-h2` and the h2 shows `1`, the h3 `1.1` — not `0.1`.
 * The TOC is relative already (markdown-it-toc-done-right nests from the
 * highest level used), so its depth is the logical level.
 */
function numberingBlock(theme: DocTheme, runtime: ThemeRuntime): string {
  const style = headingNumbering(theme)
  if (style === 'none') return ''
  // `headings.numberingDepth`: how many levels (from the highest numbered
  // one) show a number. Every level still counts, so the numbers that do
  // show stay right.
  const depth = numberingDepth(theme)
  const levels = [1, 2, 3, 4]
  const name = (l: number) => `mk-h${l}`
  const tocName = (l: number) => `mk-toc${l}`
  const gap = style === 'ieee' ? '0.5em' : '0.75em'
  const rules: string[] = []
  for (const l of levels) {
    const below = levels.filter(i => i > l)
    const reset = below.length ? `\n  counter-reset: ${below.map(name).join(' ')};` : ''
    rules.push(`.paged-doc h${l}${UNNUMBERED} {
  counter-increment: ${name(l)};${reset}
}`)
    if (l <= depth) {
      rules.push(`.paged-doc h${l}${UNNUMBERED}::before {
  content: ${numberLabel(style, levels.slice(0, l).map(name))};
  margin-right: ${gap};
  font-variant-numeric: lining-nums tabular-nums;
}`)
    }
    const tocReset = below.length ? `\n  counter-reset: ${below.map(tocName).join(' ')};` : ''
    const li = `.paged-doc .table-of-contents > ${'ul > li > '.repeat(l - 1)}ul > li${UNNUMBERED_TOC}`
    rules.push(`${li} {
  counter-increment: ${tocName(l)};${tocReset}
}`)
    if (l <= depth) {
      rules.push(`${li}::before {
  content: ${numberLabel(style, levels.slice(0, l).map(tocName))};
  min-width: ${(1.2 + 0.6 * (l - 1)).toFixed(1)}em;
  margin-right: 0.5em;
  font-variant-numeric: lining-nums tabular-nums;
}`)
    }
  }
  // Documents whose highest numbered level is h2–h4: count from there.
  for (const base of [2, 3, 4]) {
    for (const l of levels.filter(i => i >= base && i - base < depth)) {
      const counters = levels.filter(i => i >= base && i <= l).map(name)
      rules.push(`.paged-doc h${l}.${numberingBaseClass(base)}${UNNUMBERED}::before { content: ${numberLabel(style, counters)}; }`)
    }
  }
  return [
    // Number + entry on one row; a nested list wraps below.
    `.paged-doc .table-of-contents li { display: flex; flex-wrap: wrap; align-items: baseline; }
.paged-doc .table-of-contents li > a { flex: 1 1 0; min-width: 0; }
.paged-doc .table-of-contents li > ul { flex-basis: 100%; }`,
    ...rules,
    chapterLabelBlock(theme, runtime)
  ].filter(Boolean).join('\n')
}

/**
 * `headings.chapterLabel`: "Chapter 3" (in the document language, or
 * `headings.chapterWord`) on a line of its own over every numbered
 * top-level section heading — the heading of the highest level used,
 * which is also the numbering base (`headingStructure.ts`). Replaces the
 * plain number there; the TOC keeps the number.
 */
function chapterLabelBlock(theme: DocTheme, runtime: ThemeRuntime): string {
  const chapter = resolveChapterLabel(theme)
  if (!chapter.enabled) return ''
  const style = headingNumbering(theme)
  if (style === 'none') return ''
  const words = chapter.word.trim()
    ? { before: `${chapter.word.trim()} `, after: '' }
    : runtime.captionLabels?.chapter ?? { before: 'Chapter ', after: '' }
  const fmt = style === 'ieee' ? 'upper-roman' : style === 'decimal-zero' ? 'decimal-leading-zero' : 'decimal'
  const label = (l: number) => [
    words.before ? cssString(words.before) : '',
    `counter(mk-h${l}, ${fmt})`,
    words.after ? cssString(words.after) : ''
  ].filter(Boolean).join(' ')
  const look = `display: block;
  margin: 0 0 0.35em;`
  const rules = [`.paged-doc h1.${SECTION_HEADING_CLASS}${UNNUMBERED}::before {
  content: ${label(1)};
  ${look}
}`]
  for (const base of [2, 3, 4]) {
    rules.push(`.paged-doc h${base}.${SECTION_HEADING_CLASS}.${numberingBaseClass(base)}${UNNUMBERED}::before {
  content: ${label(base)};
  ${look}
}`)
  }
  return rules.join('\n')
}

/** Class `composeFinalHtml` puts on every heading of the highest level the document uses (`headingStructure.ts`). */
export const SECTION_HEADING_CLASS = 'markoto-section-heading'

/** Class `composeFinalHtml` puts on numbered headings when the highest numbered level is h`base` (2–4). */
export function numberingBaseClass(base: number): string {
  return `markoto-num-from-h${base}`
}

/** IEEEtran's number per level: \Roman. / \Alph. / \arabic) / \alph). */
const IEEE_LEVEL_FORMATS = [['upper-roman', '.'], ['upper-alpha', '.'], ['decimal', ')'], ['lower-alpha', ')']] as const

/**
 * CSS `content` for the number of a heading whose counters (outermost
 * first) are `counters` — the last one is the heading's own level.
 */
function numberLabel(style: Exclude<HeadingNumbering, 'none'>, counters: string[]): string {
  if (style === 'ieee') {
    const own = counters.at(-1) ?? ''
    const [fmt, suffix] = IEEE_LEVEL_FORMATS[counters.length - 1] ?? IEEE_LEVEL_FORMATS[3]
    return `counter(${own}, ${fmt}) "${suffix}"`
  }
  // `decimal-zero`: the top level two-digit (`01`), the levels below plain (`01.2`).
  const joined = counters.map((c, i) => style === 'decimal-zero' && i === 0 ? `counter(${c}, decimal-leading-zero)` : `counter(${c})`).join(' "." ')
  return style === 'decimal-dot' ? `${joined} "."` : joined
}

// Captions

/**
 * Table captions (`Table: …` / `: …` next to a table in the Markdown →
 * `<caption>`, renderMarkdown `tableCaptionPlugin`) in the figure-caption
 * voice, above or below the table (`tables.captionPosition`; for `below`
 * `composeFinalHtml` moves the caption to the end of the table, so a
 * table split across pages shows it under its last part). Optional
 * "Table 1: " / "Figure 1: " labels in the document language
 * (`tables.captionLabel`, `blocks.figureLabel`); only captioned tables and
 * figures count. Template CSS can restyle the label through `::before`
 * and the counters `mk-table` / `mk-figure`.
 */
function captionBlock(theme: DocTheme, runtime: ThemeRuntime): string {
  const { tablePosition, tableLabel, figureLabel, numbering, labelStyle } = resolveCaptions(theme)
  const labels = runtime.captionLabels ?? { table: 'Table', figure: 'Figure', separator: ': ' }
  const side = tablePosition === 'below' ? 'bottom' : 'top'
  const space = tablePosition === 'below' ? 'padding-top' : 'padding-bottom'
  const rules = [
    `.paged-doc table > caption {
  caption-side: ${side};
  ${space}: 0.4em;
  font-family: ${cssFontStack(theme.meta.font)};
  font-size: 0.85em;
  font-style: italic;
  color: var(--doc-secondary);
  text-align: center;
}`
  ]
  // `blocks.captionNumbering: 'chapter'`: "3.1" from the number
  // `composeFinalHtml` writes on the caption (captionNumbers.ts) — CSS
  // counters can't reset per section level the document happens to use.
  const number = (counter: string) => numbering === 'chapter' ? `attr(${CAPTION_NUMBER_ATTR})` : `counter(${counter})`
  // `blocks.captionLabelStyle: 'stacked'`: a bold upright label on its own
  // line, the title under it without separator (APA). The label is in the
  // text colour: the bold cut of a light caption colour (the default
  // caption is `--doc-secondary`, small, often in a mono face) read as a
  // light weight.
  const stacked = labelStyle === 'stacked'
  const separator = stacked ? '' : ` ${cssString(labels.separator)}`
  const stackedLook = stacked ? ' display: block; font-style: normal; font-weight: 700; color: var(--doc-text);' : ''
  if (tableLabel) {
    rules.push(`.paged-doc table > caption { counter-increment: mk-table; }
.paged-doc table > caption::before { content: ${cssString(`${labels.table} `)} ${number('mk-table')}${separator};${stackedLook} }`)
  }
  if (figureLabel) {
    rules.push(`.paged-doc figcaption:not(:empty) { counter-increment: mk-figure; }
.paged-doc figcaption:not(:empty)::before { content: ${cssString(`${labels.figure} `)} ${number('mk-figure')}${separator};${stackedLook} }`)
  }
  return rules.join('\n')
}

/** Attribute with a caption's chapter-relative number ("3.1"), written by `app/utils/markdown/captionNumbers.ts`. */
export const CAPTION_NUMBER_ATTR = 'data-markoto-number'

// References

/**
 * The reference list: `composeFinalHtml` marks the lists and paragraphs of
 * the section headed References / Bibliography / Literatur / Références …
 * `markoto-references` (`app/utils/markdown/references.ts`), so the look survives a
 * list continued on the next page or column. `blocks.referenceStyle`:
 * `hanging` indents every line but the first; `brackets` labels numbered
 * lists `[1]`, `[2]` (and hangs paragraphs and bullet entries). The indent
 * is `--doc-reference-indent` (template CSS can set it).
 */
function referencesBlock(theme: DocTheme): string {
  const style = referenceStyle(theme)
  if (style === 'plain') return ''
  const indent = 'var(--doc-reference-indent, 1.5em)'
  const rules = [
    `.paged-doc p.markoto-references { padding-left: ${indent}; text-indent: calc(-1 * ${indent}); }`,
    `.paged-doc ul.markoto-references { list-style: none; padding-left: ${indent}; }
.paged-doc ul.markoto-references > li { text-indent: calc(-1 * ${indent}); }`
  ]
  if (style === 'brackets') {
    rules.push(`.paged-doc ol.markoto-references { padding-left: 2.4em; }
.paged-doc ol.markoto-references > li::marker { content: "[" counter(list-item) "]\\2002"; font-variant-numeric: lining-nums tabular-nums; }`)
  }
  return rules.join('\n')
}

// Running section title

/** Named string behind the `{section}` header/footer token. */
const SECTION_STRING = 'mk-section'

/**
 * `{section}`: paged.js `string-set` on the document's top-level section
 * headings (`markoto-section-heading`, marked by `composeFinalHtml` — h1,
 * or h2 in a document without h1). The token reads the first one that
 * starts on the page, else the one running on from before. Only emitted
 * when a header/footer slot uses the token.
 */
function sectionStringBlock(theme: DocTheme): string {
  const slots = [theme.header, theme.footer].flatMap(s => [s.left, s.center, s.right])
  if (!slots.some(t => t.includes('{section}'))) return ''
  // paged.js 0.4.3 reads `content()` (the text, without the CSS number)
  // and `attr()` only. With `header.sectionNumber` the heading carries
  // "3 Procedures" in `data-markoto-section` (headingStructure.ts).
  const value = resolveSectionToken(theme).number ? `attr(${SECTION_LABEL_ATTR})` : 'content(text)'
  return `.paged-doc .markoto-section-heading { string-set: ${SECTION_STRING} ${value}; }`
}

/** Attribute with the section number + title, set on every top-level section heading when `header.sectionNumber` is on. */
export const SECTION_LABEL_ATTR = 'data-markoto-section'

// Page break

/**
 * Hard page break. The \`<!-- pagebreak -->\` marker in source
 * (handled by the custom block rule in renderMarkdown.ts) renders as
 * an empty \`<div class="page-break">\`; \`break-after: page\` tells
 * paged.js to start a new page after it.
 */
function pageBreakBlock(): string {
  return `.paged-doc .page-break {
  break-after: page;
  page-break-after: always;
  height: 0;
}`
}

// Multi-column spanners

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
function columnSpanBlock(theme: DocTheme): string {
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

// Cover page

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
function coverBlock(theme: DocTheme): string {
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
function repeatTitleBlock(theme: DocTheme): string {
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

// Title block (papers)

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

// Cover-layout helpers (per-layout CSS)

interface CoverCtx {
  justifyItems: string
  align: 'left' | 'center' | 'right'
  coverHeightMm: string
}

/**
 * Map the cover-page text-align value to the CSS Grid `justify-items`
 * keyword. Used uniformly across all cover layouts so a `text-align: right`
 * cover also right-aligns the logo / title block.
 */
function textAlignToJustifyItems(align: 'left' | 'center' | 'right'): string {
  if (align === 'left') return 'start'
  if (align === 'right') return 'end'
  return 'center'
}

/** flexbox equivalent of `justify-items` (for non-grid layouts). */
function justifyItemsToFlexAlign(j: string): string {
  if (j === 'start') return 'flex-start'
  if (j === 'end') return 'flex-end'
  return 'center'
}

function renderCoverLayoutCss(layout: string, ctx: CoverCtx): string {
  if (layout === 'title-block') return ''
  if (layout === 'editorial') return editorialCoverCss(ctx)
  if (layout === 'banner') return bannerCoverCss(ctx)
  if (layout === 'minimal') return minimalCoverCss(ctx)
  return classicCoverCss(ctx)
}

/**
 * Editorial: 6-row grid (logo → spacer 1fr → title+subtitle → spacer 1fr
 * → meta → spacer 1fr). Three equal spacers anchor logo at top, title
 * block at ~1/3, meta at ~2/3, with the bottom third intentionally empty.
 * A short accent rule sits above the title and a hairline above the
 * author/date block; a cover without a logo gets a full-bleed accent band
 * along the top edge (`markoto-cover--no-logo`, set by coverHtml.ts) so
 * it isn't a bare white sheet — the editorial cousin of `banner`.
 * The subtitle sits at the top of the spacer row under the title: two
 * items in ONE row of a grid without explicit columns get auto-placed
 * side by side (title left, subtitle right), so every item is pinned to
 * column 1.
 */
function editorialCoverCss({ justifyItems, align, coverHeightMm }: CoverCtx): string {
  return `.paged-doc .markoto-cover {
  page: cover-page;
  break-after: page;
  page-break-after: always;
  display: grid;
  grid-template-rows: auto 1fr auto 1fr auto 1fr;
  justify-items: ${justifyItems};
  align-items: start;
  text-align: ${align};
  height: ${coverHeightMm};
  padding: 24mm 18mm;
  box-sizing: border-box;
}
.paged-doc .markoto-cover-logo { grid-row: 1; grid-column: 1; }
.paged-doc .markoto-cover-title { grid-row: 3; grid-column: 1; }
.paged-doc .markoto-cover-title::before {
  content: '';
  display: block;
  width: 16mm;
  height: 0;
  border-top: 2.5pt solid var(--doc-brand);
  margin: 0 ${align === 'right' ? '0' : 'auto'} 0.45em ${align === 'left' ? '0' : 'auto'};
}
.paged-doc .markoto-cover-subtitle { grid-row: 4; grid-column: 1; align-self: start; }
.paged-doc .markoto-cover-meta {
  grid-row: 5;
  grid-column: 1;
  border-top: 0.75pt solid color-mix(in srgb, var(--doc-secondary) 60%, transparent);
  padding-top: 0.9em;
  min-width: 55%;
}
.paged-doc .markoto-cover--no-logo {
  background: linear-gradient(var(--doc-brand), var(--doc-brand)) top left / 100% 7mm no-repeat;
}`
}

/**
 * Banner: brand-tinted top band holding logo + title, page colour beneath
 * with subtitle and meta. One full-width grid column; the band is the
 * cover's `::before` (a grid item spanning the logo + title rows) so the
 * logo keeps its own size and the title its own width — painting the
 * tint on the logo `<img>` itself stretched an empty tinted box beside
 * the title. With no logo, the title is the first child and takes the
 * band's top padding itself.
 */
function bannerCoverCss({ justifyItems, align, coverHeightMm }: CoverCtx): string {
  return `.paged-doc .markoto-cover {
  page: cover-page;
  break-after: page;
  page-break-after: always;
  display: grid;
  grid-template-columns: 100%;
  grid-template-rows: auto auto auto 1fr auto;
  justify-items: ${justifyItems};
  text-align: ${align};
  height: ${coverHeightMm};
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}
.paged-doc .markoto-cover::before {
  content: '';
  grid-row: 1 / 3;
  grid-column: 1;
  justify-self: stretch;
  align-self: stretch;
  background: color-mix(in srgb, var(--doc-brand) 12%, var(--doc-bg));
}
.paged-doc .markoto-cover-logo { grid-row: 1; grid-column: 1; box-sizing: content-box; padding: 24mm 18mm 0 18mm; }
.paged-doc .markoto-cover-title { grid-row: 2; grid-column: 1; box-sizing: border-box; max-width: 100%; margin: 0; padding: 0.6em 18mm 18mm 18mm; }
.paged-doc .markoto-cover-title:first-child { padding-top: 24mm; }
.paged-doc .markoto-cover-subtitle { grid-row: 3; grid-column: 1; box-sizing: border-box; max-width: 100%; margin: 0; padding: 14mm 18mm 0 18mm; }
.paged-doc .markoto-cover-meta { grid-row: 5; grid-column: 1; margin: 0; padding: 0 18mm 24mm 18mm; }`
}

/**
 * Minimal: title (and optional subtitle) centered. Logo + meta are
 * HIDDEN in this layout regardless of their toggles — "minimal" is a
 * stronger statement than "what you toggled on".
 */
function minimalCoverCss({ justifyItems, align, coverHeightMm }: CoverCtx): string {
  return `.paged-doc .markoto-cover {
  page: cover-page;
  break-after: page;
  page-break-after: always;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: ${justifyItemsToFlexAlign(justifyItems)};
  text-align: ${align};
  height: ${coverHeightMm};
  padding: 24mm 18mm;
  box-sizing: border-box;
}
.paged-doc .markoto-cover-logo,
.paged-doc .markoto-cover-meta { display: none; }`
}

/**
 * Classic — flex-column, vertically centered, everything stacked.
 * Default spacing between elements via per-element margins.
 */
function classicCoverCss({ justifyItems, align, coverHeightMm }: CoverCtx): string {
  return `.paged-doc .markoto-cover {
  page: cover-page;
  break-after: page;
  page-break-after: always;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: ${justifyItemsToFlexAlign(justifyItems)};
  text-align: ${align};
  height: ${coverHeightMm};
  padding: 24mm 18mm;
  box-sizing: border-box;
}`
}

// Page-break hints (typography hygiene)

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
function breakHints(columns: number): string {
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

// Helpers

/**
 * Serialise `s` as a double-quoted CSS string (CSSOM "serialize a
 * string"): `"` and `\` are backslash-escaped, NUL becomes U+FFFD, and
 * every other control character (incl. newline, which would otherwise
 * end the string and let the rest of the value become CSS) is written as
 * a hex escape. Every generated string value goes through here.
 */
function cssString(s: string): string {
  let out = '"'
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0) out += '\uFFFD'
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(16)} `
    else if (ch === '"' || ch === '\\') out += `\\${ch}`
    else out += ch
  }
  return out + '"'
}

function cssFontStack(name: string): string {
  const escaped = name.replaceAll('"', String.raw`\"`)
  const safe = name.includes(' ') ? `"${escaped}"` : name
  return `${safe}, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
}
