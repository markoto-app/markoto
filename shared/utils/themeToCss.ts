import type { DocTheme, RunningSlots } from '../types/theme'

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
  date: string  // ISO YYYY-MM-DD
}

/**
 * Compile a DocTheme into a single CSS stylesheet that drives both the
 * live paged preview and the PDF print iframe.
 */
export function themeToCss(theme: DocTheme, runtime: ThemeRuntime): string {
  return [
    pageBlock(theme, runtime),
    rootBlock(theme),
    typographyBlock(theme),
    tableBlock(theme),
    blockBlock(theme),
    codeBlock(theme),
    alertBlock(),
    katexBlock(),
    mermaidBlock(),
    tocBlock(theme),
    breakHints()
  ].join('\n\n')
}

/**
 * Google Fonts @import URL for the theme's fonts. Returned separately
 * so changing a color doesn't trigger a font refetch.
 */
export function themeFontsImport(theme: DocTheme): string {
  const unique = [...new Set([theme.body.font, theme.headings.font])]
    .filter(f => f && f.trim())
  if (unique.length === 0) return ''
  const families = unique.map(googleFamilyParam).join('&')
  return `@import url('https://fonts.googleapis.com/css2?${families}&display=swap');`
}

// — page block ————————————————————————————————————————————————————————

function pageBlock(theme: DocTheme, runtime: ThemeRuntime): string {
  const { size, orientation, margin } = theme.page
  const textColor = theme.body.color
  const headerSlots = renderMarginBoxes(theme.header, 'top', runtime, textColor)
  const footerSlots = renderMarginBoxes(theme.footer, 'bottom', runtime, textColor)
  return `@page {
  size: ${size} ${orientation};
  margin: ${margin}mm;
${headerSlots}
${footerSlots}
  @footnote {
    border-top: 0.5pt solid ${textColor};
    padding-top: 4pt;
    margin-top: 8pt;
    font-size: 8pt;
    line-height: 1.3;
  }
}`
}

function renderMarginBoxes(slots: RunningSlots, edge: 'top' | 'bottom', runtime: ThemeRuntime, textColor: string): string {
  const boxes: { name: string; tpl: string }[] = [
    { name: `${edge}-left`, tpl: slots.left },
    { name: `${edge}-center`, tpl: slots.center },
    { name: `${edge}-right`, tpl: slots.right }
  ]
  return boxes
    .filter(b => b.tpl.trim())
    .map(b => `  @${b.name} {
    content: ${compileTemplate(b.tpl, runtime)};
    font-size: 9pt;
    color: ${textColor};
    opacity: 0.7;
  }`)
    .join('\n')
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

function rootBlock(theme: DocTheme): string {
  const { brand } = theme.color
  const { color: text, background, font, size, lineHeight } = theme.body
  const { columns, columnGap } = theme.layout
  return `.paged-doc {
  --doc-brand: ${brand};
  --doc-text: ${text};
  --doc-bg: ${background};
  --doc-heading-color: ${theme.headings.color};
  font-family: ${cssFontStack(font)};
  font-size: ${size}pt;
  line-height: ${lineHeight};
  color: var(--doc-text);
  background: var(--doc-bg);
${columns > 1 ? `  column-count: ${columns};\n  column-gap: ${columnGap}mm;\n  column-fill: auto;` : ''}
}`
}

// — typography ————————————————————————————————————————————————————————

function typographyBlock(theme: DocTheme): string {
  const bodySize = theme.body.size
  const { font: headingFont, scale, weight, underline } = theme.headings
  const headingFamily = cssFontStack(headingFont)
  const headingRules: string[] = []
  // Modular scale: h6 at body, h1 at body * scale^5
  for (let level = 1; level <= 6; level++) {
    const exponent = 6 - level
    const sizePt = (bodySize * Math.pow(scale, exponent)).toFixed(2)
    headingRules.push(`.paged-doc h${level} {
  font-family: ${headingFamily};
  font-size: ${sizePt}pt;
  font-weight: ${weight};
  line-height: 1.2;
  color: var(--doc-heading-color);
  margin-top: ${(level <= 2 ? 1.4 : 1.0).toFixed(2)}em;
  margin-bottom: 0.5em;${underline ? `\n  border-bottom: 1px solid var(--doc-brand);\n  padding-bottom: 0.2em;` : ''}
}`)
  }

  // Justified paragraphs need hyphenation (otherwise word-spacing
  // rivers) and `text-align-last: left` so the final line of each
  // paragraph isn't stretched.
  const align = theme.body.textAlign
  const justifyExtras = align === 'justify'
    ? `\n  hyphens: auto;\n  -webkit-hyphens: auto;\n  text-align-last: left;`
    : ''

  return [
    headingRules.join('\n'),
    // Suppress top margin on the leading element so an opening h1
    // doesn't push whitespace at the top of page 1.
    `.paged-doc > :first-child { margin-top: 0; }`,
    `.paged-doc p { margin: 0.6em 0; orphans: 3; widows: 3; text-align: ${align};${justifyExtras} }`,
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
    `.paged-doc figcaption { font-size: 0.85em; color: color-mix(in srgb, var(--doc-text) 70%, var(--doc-bg)); margin-top: 0.4em; font-style: italic; }`,
    `.paged-doc hr { border: none; border-top: 1px solid var(--doc-text); opacity: 0.2; margin: 1.5em 0; }`,
    // Footnote support — see `transformFootnotesForPagedMedia` in
    // app/utils/renderMarkdown.ts.
    `.paged-doc .footnote { float: footnote; font-size: 0.85em; }`,
    `.paged-doc ::footnote-call { content: counter(footnote); vertical-align: super; font-size: 0.7em; color: var(--doc-brand); line-height: 0; }`,
    `.paged-doc ::footnote-marker { content: counter(footnote) ". "; font-weight: 600; color: var(--doc-brand); }`
  ].join('\n')
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
      borderRules = `.paged-doc tr { border-bottom: 1px solid color-mix(in srgb, var(--doc-text) 30%, transparent); }
.paged-doc tr:last-child { border-bottom: none; }`
      break
    case 'minimal':
      borderRules = `.paged-doc table { border-top: 2px solid var(--doc-text); border-bottom: 2px solid var(--doc-text); }
.paged-doc thead { border-bottom: 1px solid var(--doc-text); }`
      break
    case 'none':
      borderRules = ''
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
      headerBg = ''
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
 * each in its own semantic color so the meaning reads at a glance even
 * when the doc theme picks an unrelated brand. Colors mirror GitHub's
 * own admonition palette (blue/green/purple/amber/red) — these are
 * intentionally NOT theme-driven because the alert kind itself carries
 * meaning that the brand color shouldn't override.
 *
 * HTML structure (from the plugin):
 *   <div class="markdown-alert markdown-alert-{kind}">
 *     <p class="markdown-alert-title">Note</p>
 *     <p>...body...</p>
 *   </div>
 */
function alertBlock(): string {
  const kinds: Array<{ name: string; color: string }> = [
    { name: 'note', color: '#0969da' },
    { name: 'tip', color: '#1a7f37' },
    { name: 'important', color: '#8250df' },
    { name: 'warning', color: '#9a6700' },
    { name: 'caution', color: '#cf222e' }
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
function tocBlock(theme: DocTheme): string {
  const { maxDepth, showPageNumbers, leaderStyle } = theme.toc

  // Renderer always emits up to h4 (4 nested ULs in worst case). To
  // honor a smaller maxDepth, hide every ul beyond that level. depth 2
  // keeps only the second-level ul (h2 entries under h1), so we hide
  // any ul nested 2+ deep inside that.
  const depthHide: string[] = []
  if (maxDepth < 4) depthHide.push(`.paged-doc .table-of-contents ul ul ul ul { display: none; }`)
  if (maxDepth < 3) depthHide.push(`.paged-doc .table-of-contents ul ul ul { display: none; }`)
  if (maxDepth < 2) depthHide.push(`.paged-doc .table-of-contents ul ul { display: none; }`)

  // Leader: a flex item with a bottom border. \`none\` skips the rule
  // entirely so the layout collapses to title-then-page-number with no
  // line between them.
  const leaderRule = leaderStyle === 'none'
    ? ''
    : `.paged-doc .table-of-contents a::before {
  content: '';
  flex: 1;
  order: 2;
  border-bottom: 1px ${leaderStyle} color-mix(in srgb, var(--doc-text) 35%, transparent);
  transform: translateY(-0.25em);
  margin: 0 0.3em;
}`

  // Page numbers via paged.js target-counter. When disabled we drop
  // the ::after rule and the leader's flex:1 still spreads to the
  // right edge (link text on left, blank space / leader to the right).
  const pageNumberRule = showPageNumbers
    ? `.paged-doc .table-of-contents a::after {
  content: target-counter(attr(href url), page);
  order: 3;
  font-variant-numeric: tabular-nums;
  color: color-mix(in srgb, var(--doc-text) 70%, var(--doc-bg));
}`
    : ''

  return [
    `.paged-doc .table-of-contents {
  margin: 1.2em 0;
  break-inside: avoid;
}`,
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

// — page-break hints (typography hygiene) —————————————————————————————

function breakHints(): string {
  return [
    `.paged-doc h1, .paged-doc h2, .paged-doc h3 { break-after: avoid-page; }`,
    `.paged-doc img, .paged-doc pre, .paged-doc table, .paged-doc blockquote { break-inside: avoid; }`
  ].join('\n')
}

// — helpers ———————————————————————————————————————————————————————————

function cssString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

function cssFontStack(name: string): string {
  const safe = name.includes(' ') ? `"${name.replace(/"/g, '\\"')}"` : name
  return `${safe}, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
}

function googleFamilyParam(name: string): string {
  return `family=${name.trim().replace(/ /g, '+')}:wght@400;500;600;700;800`
}
