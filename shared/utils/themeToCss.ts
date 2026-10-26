import type { DocTheme, RunningSlots } from '../types/theme'
import { pageHeightMm } from './pageDimensions'
import type { CustomCssResult } from '../types/customCss'

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
  date: string // ISO YYYY-MM-DD
  // Localized text rendered by CSS \`content:\` for the optional TOC
  // heading. Lives in runtime (not the theme) because i18n strings
  // shouldn't be persisted to the doc — same translation should apply
  // when the doc opens in another language.
  tocTitle: string
  /**
   * The document's custom CSS AFTER `sanitizeCustomCss` (shared/utils/customCss.ts).
   * Appended last so user rules override the theme. Typed as the
   * sanitizer's result (not a bare string) so a call site can't hand the
   * raw `theme.customCss` through by accident — `theme.customCss` itself
   * is never read here.
   */
  customCss?: CustomCssResult
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
    katexBlock(),
    mermaidBlock(),
    tocBlock(theme, runtime),
    pageBreakBlock(),
    columnSpanBlock(),
    coverBlock(theme),
    breakHints()
  ]
  const custom = runtime.customCss?.css
  if (custom) blocks.push(`/* custom css */\n${custom}`)
  return blocks.join('\n\n')
}

/**
 * Google Fonts @import URL for the theme's fonts. Returned separately
 * so changing a color doesn't trigger a font refetch.
 */
export function themeFontsImport(theme: DocTheme): string {
  const unique = [...new Set([theme.body.font, theme.headings.font, theme.meta.font])]
    .filter(f => f?.trim())
  if (unique.length === 0) return ''
  const families = unique.map(googleFamilyParam).join('&')
  return `@import url('https://fonts.googleapis.com/css2?${families}&display=swap');`
}

// — page block ————————————————————————————————————————————————————————

function pageBlock(theme: DocTheme, runtime: ThemeRuntime): string {
  const { size, orientation, margin } = theme.page
  const textColor = theme.body.color
  const metaFont = theme.meta.font
  const headerSlots = renderMarginBoxes(theme.header, 'top', runtime, textColor, metaFont)
  const footerSlots = renderMarginBoxes(theme.footer, 'bottom', runtime, textColor, metaFont)
  const secondaryColor = theme.color.secondary
  return `@page {
  size: ${size} ${orientation};
  margin: ${margin}mm;
${headerSlots}
${footerSlots}
  @footnote {
    border-top: 0.5pt solid ${secondaryColor};
    padding-top: 4pt;
    margin-top: 8pt;
    font-size: 8pt;
    line-height: 1.3;
  }
}`
}

type RunningSlotPosition = 'left' | 'center' | 'right'

function renderMarginBoxes(slots: RunningSlots, edge: 'top' | 'bottom', runtime: ThemeRuntime, textColor: string, metaFont: string): string {
  // The optional image (if `imageUrl` is set) wins over text in the slot
  // it lands in — same slot can't show both. Users typically pick one
  // mental model per slot anyway. paged.js margin boxes accept
  // `content: url('...')` per CSS Paged Media; the image inherits the
  // slot's vertical alignment from the @top-X box itself.
  const imgSlot = slots.imageUrl.trim() ? slots.imagePosition : null
  const text: Record<RunningSlotPosition, string> = {
    left: slots.left,
    center: slots.center,
    right: slots.right
  }
  const positions = ['left', 'center', 'right'] as const
  const out: string[] = []
  for (const pos of positions) {
    const boxName = `${edge}-${pos}`
    if (imgSlot === pos) {
      // Image slot — escape single-quotes in URLs (none expected for
      // /api/files, but defense in depth) and pin the image height in
      // pt so it lines up with the running header's text-size scale.
      const safeUrl = slots.imageUrl.replaceAll('\'', String.raw`\'`)
      out.push(`  @${boxName} {
    content: url('${safeUrl}');
    height: ${slots.imageHeight}pt;
    width: auto;
  }`)
      continue
    }
    const tpl = text[pos].trim()
    if (!tpl) continue
    out.push(`  @${boxName} {
    content: ${compileTemplate(tpl, runtime)};
    font-family: ${cssFontStack(metaFont)};
    font-size: 9pt;
    color: ${textColor};
    opacity: 0.7;
  }`)
  }
  return out.join('\n')
}

function compileTemplate(template: string, runtime: ThemeRuntime): string {
  const parts: string[] = []
  const regex = /\{(title|page|pages|date)\}/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(template)) !== null) {
    if (match.index > lastIndex) {
      parts.push(cssString(template.slice(lastIndex, match.index)))
    }
    parts.push(tokenToCss(match[1]!, runtime))
    lastIndex = regex.lastIndex
  }
  if (lastIndex < template.length) {
    parts.push(cssString(template.slice(lastIndex)))
  }
  return parts.length ? parts.join(' ') : '""'
}

function tokenToCss(token: string, runtime: ThemeRuntime): string {
  switch (token) {
    case 'title': return cssString(runtime.title)
    case 'page': return 'counter(page)'
    case 'pages': return 'counter(pages)'
    case 'date': return cssString(runtime.date)
    default: return '""'
  }
}

// — root block ————————————————————————————————————————————————————————

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
}`
}

// — typography ————————————————————————————————————————————————————————

function typographyBlock(theme: DocTheme): string {
  const bodySize = theme.body.size
  const { font: headingFont, scale, weight, underline, letterSpacing, lineHeight: hLineHeight, spacingScale } = theme.headings
  const headingFamily = cssFontStack(headingFont)
  const headingRules: string[] = []
  // Modular scale: h6 at body, h1 at body * scale^5. Top-margin is
  // base-em × user spacingScale (1.0 = traditional print rhythm).
  for (let level = 1; level <= 6; level++) {
    const exponent = 6 - level
    const sizePt = (bodySize * Math.pow(scale, exponent)).toFixed(2)
    const baseTop = level <= 2 ? 1.4 : 1
    const marginTop = (baseTop * spacingScale).toFixed(2)
    headingRules.push(`.paged-doc h${level} {
  font-family: ${headingFamily};
  font-size: ${sizePt}pt;
  font-weight: ${weight};
  line-height: ${hLineHeight};
  letter-spacing: ${letterSpacing}em;
  color: var(--doc-heading-color);
  margin-top: ${marginTop}em;
  margin-bottom: 0.5em;${underline ? `\n  border-bottom: 1px solid var(--doc-brand);\n  padding-bottom: 0.2em;` : ''}
}`)
  }

  // Hyphenation is now an explicit body knob (decoupled from textAlign).
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
}`
    : ''

  return [
    headingRules.join('\n'),
    // Suppress top margin on the leading element so an opening h1
    // doesn't push whitespace at the top of page 1.
    `.paged-doc > :first-child { margin-top: 0; }`,
    `.paged-doc p { margin: ${paragraphMargin}em 0; orphans: 3; widows: 3; text-align: ${align};${justifyExtras} }${firstLineIndentCss}`,
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
    `.paged-doc figcaption { font-family: ${cssFontStack(theme.meta.font)}; font-size: 0.85em; color: var(--doc-secondary); margin-top: 0.4em; font-style: italic; }`,
    hrCss(theme),
    // Footnote support — see `transformFootnotesForPagedMedia` in
    // app/utils/renderMarkdown.ts.
    `.paged-doc .footnote { float: footnote; font-family: ${cssFontStack(theme.meta.font)}; font-size: 0.85em; }`,
    `.paged-doc ::footnote-call { content: counter(footnote); vertical-align: super; font-size: 0.7em; color: var(--doc-brand); line-height: 0; }`,
    `.paged-doc ::footnote-marker { content: counter(footnote) ". "; font-weight: 600; color: var(--doc-brand); }`,
    dropCapRule
  ].filter(Boolean).join('\n')
}

// — tables ————————————————————————————————————————————————————————————

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
.paged-doc tr:last-child { border-bottom: none; }`
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
}`,
    `.paged-doc th {
  font-weight: 600;
  ${headerBg}
  ${headerColor}
}`,
    borderRules,
    zebraRule
  ].filter(Boolean).join('\n')
}

// — blocks (images / blockquote) ——————————————————————————————————————

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

// — code ——————————————————————————————————————————————————————————————

function codeBlock(theme: DocTheme): string {
  const monoStack = `ui-monospace, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace`
  const { theme: codeTheme, fontSize } = theme.code

  // Inline code is always lightly tinted regardless of code theme — it
  // sits inline with body text and shouldn't pull a heavy fill.
  const inlineCode = `.paged-doc :not(pre) > code {
  font-family: ${monoStack};
  font-size: 0.88em;
  padding: 0.1em 0.35em;
  border-radius: 3px;
  background: color-mix(in srgb, var(--doc-text) 8%, transparent);
}`

  if (codeTheme === 'none') {
    // No syntax styling. Strip the .hljs background that the hljs
    // stylesheet would otherwise paint, so the block reads as plain
    // monospace on the page background.
    return [
      inlineCode,
      `.paged-doc pre {
  font-family: ${monoStack};
  font-size: ${fontSize}pt;
  margin: 1em 0;
  padding: 0.5em 0;
}`,
      `.paged-doc pre code.hljs { background: none; padding: 0; color: inherit; }`
    ].join('\n')
  }

  // For all other themes, hljs's stylesheet (loaded into the iframe
  // head from CDN — see hljsCdn.ts) owns the code block visuals
  // (background, foreground, padding, per-token colors). Theme CSS
  // only controls the surrounding box: font stack + size, margin,
  // border-radius, overflow.
  return [
    inlineCode,
    `.paged-doc pre {
  font-family: ${monoStack};
  font-size: ${fontSize}pt;
  margin: 1em 0;
  border-radius: 4px;
  overflow-x: auto;
}`
  ].join('\n')
}

// — alerts (GitHub-style admonitions) —————————————————————————————————

/**
 * GitHub-style alert blocks emitted by `@mdit/plugin-alert`. Five kinds,
 * each in its own semantic color so the meaning reads at a glance. The
 * palette is now THEME-DRIVEN via `theme.alerts.{note|tip|important|
 * warning|caution}` — every preset commits to its own admonition look.
 * The Modern preset keeps the GitHub colours; markoto picks a desaturated
 * warm-paper variant; the rest follow their own brand voice. This is
 * what lets a vermillion-on-cream theme stop slamming a saturated
 * blue/green/purple admonition into the page.
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

// — KaTeX math —————————————————————————————————————————————————————————

/**
 * Layout-only adjustments around `@mdit/plugin-katex` output. Glyph
 * positioning and font selection come from the KaTeX stylesheet (loaded
 * via CDN inside the iframe). What remains here is print-context hygiene:
 * block math gets a vertical breathing room, doesn't break across pages,
 * and overflows horizontally rather than clipping when the equation is
 * wider than the page.
 */
function katexBlock(): string {
  return [
    `.paged-doc .katex-display {
  margin: 1em 0;
  overflow-x: auto;
  overflow-y: hidden;
  break-inside: avoid;
}`,
    `.paged-doc .katex { font-size: 1.05em; }`
  ].join('\n')
}

// — mermaid diagrams ——————————————————————————————————————————————————

/**
 * Mermaid renders to inline SVG inside a `<div class="mermaid">` (the
 * preview/print iframes do the substitution before paged.js paginates;
 * see usePagedPreview + printPdf). All visual styling — node fills,
 * label fonts, edge colors — comes from mermaid's own theme set via
 * \`mermaid.initialize({ theme })\`. What's left here is layout glue:
 * center the diagram, cap its width, and avoid splitting across pages.
 */
function mermaidBlock(): string {
  return [
    `.paged-doc .mermaid {
  margin: 1em auto;
  text-align: center;
  break-inside: avoid;
}`,
    `.paged-doc .mermaid svg {
  max-width: 100%;
  height: auto;
  /* Without this, the SVG hard-clips foreignObject HTML labels at the
     foreignObject's own bbox even when the inner text is wider — the
     symptom is "YPad document" rendering as "YPad docume". Letting
     the SVG paint beyond its viewport keeps overflowing labels visible. */
  overflow: visible;
}`,
    // foreignObject defines a clipping viewport in SVG. mermaid sizes
    // the foreignObject from a pre-render measurement that comes up
    // short on multi-character labels (font metrics drift between
    // measurement context and final render context). Forcing
    // overflow:visible on foreignObject + nowrap on the inner content
    // keeps every character readable even when mermaid undersizes the
    // surrounding shape.
    `.paged-doc .mermaid foreignObject {
  overflow: visible;
}`,
    `.paged-doc .mermaid foreignObject > div,
.paged-doc .mermaid foreignObject span,
.paged-doc .mermaid foreignObject p {
  white-space: nowrap;
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

// — table of contents —————————————————————————————————————————————————

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

  // Renderer always emits up to h4 (4 nested ULs in worst case). To
  // honor a smaller maxDepth, hide every ul beyond that level. depth 2
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
    // Bottom margin bumped from 1.2em to 2.2em so the TOC has visible
    // breathing room before the first chapter heading — without it,
    // the TOC felt jammed against the body content.
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
  margin: 0.1em 0;
}`,
    `.paged-doc .table-of-contents li {
  margin: 0.25em 0;
  break-inside: avoid;
}`,
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

// — page break ————————————————————————————————————————————————————————

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

// — multi-column spanners ———————————————————————————————————————————————

/**
 * In multi-column layouts (newsletter, magazine), the doc title and
 * the table of contents read better when they span the full page width
 * rather than getting jammed into the first column. \`column-span: all\`
 * is the standard CSS Multi-column Layout property for this — the
 * spanned element interrupts the column flow, sits across the full
 * content area, and columns resume below it.
 *
 * Rules are unconditional: \`column-span\` is a no-op outside a
 * multi-column container, so single-column docs aren't affected.
 *
 * Why \`:first-of-type\` for the H1: scope is "the first H1 of the doc",
 * not every H1. Subsequent H1s (rare but possible) stay in-flow.
 */
function columnSpanBlock(): string {
  return [
    `.paged-doc > h1:first-of-type {
  column-span: all;
}`,
    `.paged-doc .table-of-contents {
  column-span: all;
}`
  ].join('\n')
}

// — cover page ———————————————————————————————————————————————————————

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
  const layoutCss = renderCoverLayoutCss(layout, ctx)

  return [
    layoutCss,
    `.paged-doc .markoto-cover-logo {
  display: block;
  height: ${theme.brand.logoHeight}px;
  width: auto;
  ${layout === 'editorial' || layout === 'banner' ? '' : 'margin: 0 auto 1.2em auto;'}
}`,
    `.paged-doc .markoto-cover-title {
  font-family: ${cssFontStack(theme.headings.font)};
  font-size: ${titleSize}em;
  font-weight: ${theme.headings.weight};
  line-height: 1.2;
  letter-spacing: ${theme.headings.letterSpacing}em;
  color: var(--doc-heading-color);
  margin: 0 0 0.4em 0;
}`,
    `.paged-doc .markoto-cover-subtitle {
  font-family: ${cssFontStack(theme.body.font)};
  font-size: ${subtitleSize}em;
  font-style: italic;
  color: var(--doc-secondary);
  margin: 0 0 1em 0;
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

// — cover-layout helpers (per-layout CSS) —————————————————————————————

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
  if (layout === 'editorial') return editorialCoverCss(ctx)
  if (layout === 'banner') return bannerCoverCss(ctx)
  if (layout === 'minimal') return minimalCoverCss(ctx)
  return classicCoverCss(ctx)
}

/**
 * Editorial: 6-row grid (logo → spacer 1fr → title+subtitle → spacer 1fr
 * → meta → spacer 1fr). Three equal spacers anchor logo at top, title
 * block at ~1/3, meta at ~2/3, with the bottom third intentionally empty.
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
.paged-doc .markoto-cover-logo { grid-row: 1; }
.paged-doc .markoto-cover-title { grid-row: 3; }
.paged-doc .markoto-cover-subtitle { grid-row: 3; align-self: end; margin-top: 0.4em; }
.paged-doc .markoto-cover-meta { grid-row: 5; }`
}

/**
 * Banner: brand-tinted top band with logo + title, body color beneath
 * holding subtitle and meta. Uses grid so the band can span full bleed
 * inside the named page.
 */
function bannerCoverCss({ justifyItems, align, coverHeightMm }: CoverCtx): string {
  return `.paged-doc .markoto-cover {
  page: cover-page;
  break-after: page;
  page-break-after: always;
  display: grid;
  grid-template-rows: auto 1fr auto;
  justify-items: ${justifyItems};
  text-align: ${align};
  height: ${coverHeightMm};
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}
.paged-doc .markoto-cover-logo,
.paged-doc .markoto-cover-title {
  width: 100%;
  padding-left: 18mm;
  padding-right: 18mm;
  background: color-mix(in srgb, var(--doc-brand) 12%, var(--doc-bg));
  box-sizing: border-box;
}
.paged-doc .markoto-cover-logo { grid-row: 1; padding-top: 24mm; padding-bottom: 0.6em; }
.paged-doc .markoto-cover-title { grid-row: 1; align-self: end; padding-bottom: 24mm; }
.paged-doc .markoto-cover-subtitle { grid-row: 2; padding: 18mm; }
.paged-doc .markoto-cover-meta { grid-row: 3; padding: 0 18mm 24mm 18mm; }`
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

// — page-break hints (typography hygiene) —————————————————————————————

function breakHints(): string {
  return [
    `.paged-doc h1, .paged-doc h2, .paged-doc h3 { break-after: avoid-page; }`,
    `.paged-doc img, .paged-doc pre, .paged-doc table, .paged-doc blockquote { break-inside: avoid; }`
  ].join('\n')
}

// — helpers ———————————————————————————————————————————————————————————

function cssString(s: string): string {
  return '"' + s.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`) + '"'
}

function cssFontStack(name: string): string {
  const escaped = name.replaceAll('"', String.raw`\"`)
  const safe = name.includes(' ') ? `"${escaped}"` : name
  return `${safe}, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
}

function googleFamilyParam(name: string): string {
  return `family=${name.trim().replaceAll(' ', '+')}:wght@400;500;600;700;800`
}
