import type { DocTheme, RunningSlots } from '../types/theme'

/**
 * Runtime values interpolated into the theme CSS — kept separate from the
 * theme itself because they change at a different cadence (title on rename,
 * date once per render) and because baking them into the CSS string is
 * simpler than the CSS-custom-property dance.
 *
 * Why not `var(--doc-title)` referenced from `@page` margin boxes: paged.js
 * extracts the source content, reflows it into a new tree of `pagedjs_page`
 * boxes, and the margin boxes live as siblings (not descendants) of the
 * original `.paged-doc` element. Custom properties set on `.paged-doc`
 * don't propagate up to the margin pseudo-elements, leaving headers blank.
 */
export type ThemeRuntime = {
  title: string
  date: string  // ISO YYYY-MM-DD; ship as-is, no formatting in Phase 1
}

/**
 * Compile a DocTheme into a single CSS stylesheet that drives both the live
 * paged preview and the PDF print iframe. Same theme + runtime → identical
 * output — load-bearing for "what you see in the preview is what you get
 * in the PDF". The runtime values (title, date) are interpolated into the
 * `@page` margin-box `content:` declarations directly.
 */
export function themeToCss(theme: DocTheme, runtime: ThemeRuntime): string {
  return [
    pageBlock(theme, runtime),
    rootBlock(theme),
    typographyBlock(theme),
    blockBlock(theme),
    breakHints()
  ].join('\n\n')
}

/**
 * The Google Fonts @import URL for the theme's chosen fonts. Returned
 * separately because consumers want it in the document <head>, not inline
 * with the rest of the theme CSS — that way swapping a theme color doesn't
 * trigger a font refetch.
 */
export function themeFontsImport(theme: DocTheme): string {
  const unique = [...new Set([theme.typography.bodyFont, theme.typography.headingFont])]
    .filter(f => f && f.trim())
  if (unique.length === 0) return ''
  const families = unique.map(googleFamilyParam).join('&')
  return `@import url('https://fonts.googleapis.com/css2?${families}&display=swap');`
}

// — page block ————————————————————————————————————————————————————————

function pageBlock(theme: DocTheme, runtime: ThemeRuntime): string {
  const { size, orientation, margin } = theme.page
  const textColor = theme.color.text
  const headerSlots = renderMarginBoxes(theme.header, 'top', runtime, textColor)
  const footerSlots = renderMarginBoxes(theme.footer, 'bottom', runtime, textColor)
  // @footnote area styling — separator + smaller text. paged.js renders
  // floated footnotes (.footnote { float: footnote }) into this region
  // at the bottom of each page where a reference appears.
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

/**
 * Compile a header/footer template like "Page {page} of {pages}" into the
 * CSS `content:` value:  "Page " counter(page) " of " counter(pages)
 *
 * `{title}` and `{date}` interpolate the runtime values directly into the
 * CSS string. `{page}` and `{pages}` map to paged.js's built-in counters.
 */
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
  const { brand, text, background } = theme.color
  const { columns, columnGap } = theme.layout
  return `.paged-doc {
  --doc-brand: ${brand};
  --doc-text: ${text};
  --doc-bg: ${background};
  font-family: ${cssFontStack(theme.typography.bodyFont)};
  font-size: ${theme.typography.bodySize}pt;
  line-height: ${theme.typography.lineHeight};
  color: var(--doc-text);
  background: var(--doc-bg);
${columns > 1 ? `  column-count: ${columns};\n  column-gap: ${columnGap}mm;` : ''}
}`
}

// — typography ————————————————————————————————————————————————————————

function typographyBlock(theme: DocTheme): string {
  const { bodySize, headingFont, headingScale, headingUnderline } = theme.typography
  const headingFamily = cssFontStack(headingFont)
  const headingRules: string[] = []
  // Modular scale: h6 at body, h1 at body * scale^5
  for (let level = 1; level <= 6; level++) {
    const exponent = 6 - level
    const sizePt = (bodySize * Math.pow(headingScale, exponent)).toFixed(2)
    headingRules.push(`.paged-doc h${level} {
  font-family: ${headingFamily};
  font-size: ${sizePt}pt;
  font-weight: 600;
  line-height: 1.2;
  margin-top: ${(level <= 2 ? 1.4 : 1.0).toFixed(2)}em;
  margin-bottom: 0.5em;${headingUnderline ? `\n  border-bottom: 1px solid var(--doc-brand);\n  padding-bottom: 0.2em;` : ''}
}`)
  }
  return [
    headingRules.join('\n'),
    `.paged-doc p { margin: 0.6em 0; orphans: 3; widows: 3; }`,
    `.paged-doc strong { font-weight: 700; }`,
    `.paged-doc em { font-style: italic; }`,
    `.paged-doc a {
  color: var(--doc-brand);
  text-decoration: underline;
}`,
    `.paged-doc ul { list-style-type: disc; padding-left: 1.4em; margin: 0.5em 0; }`,
    `.paged-doc ol { list-style-type: decimal; padding-left: 1.4em; margin: 0.5em 0; }`,
    `.paged-doc li { margin: 0.2em 0; }`,
    `.paged-doc li.task-list-item { list-style-type: none; margin-left: -1.2em; }`,
    `.paged-doc li.task-list-item input[type="checkbox"] { margin-right: 0.4em; }`,
    `.paged-doc hr { border: none; border-top: 1px solid var(--doc-text); opacity: 0.2; margin: 1.5em 0; }`,
    `.paged-doc table { border-collapse: collapse; width: 100%; margin: 1em 0; }`,
    `.paged-doc th, .paged-doc td { border: 1px solid var(--doc-text); padding: 0.4em 0.6em; text-align: left; }`,
    `.paged-doc th { font-weight: 600; background: color-mix(in srgb, var(--doc-text) 6%, transparent); }`,
    // Footnotes — `transformFootnotesForPagedMedia` (renderMarkdown.ts)
    // converts markdown-it-footnote's end-of-doc <section> into inline
    // <span class="footnote"> elements. `float: footnote` is the CSS Print
    // signal paged.js uses to lift each one into the page-bottom @footnote
    // area defined in pageBlock().
    `.paged-doc .footnote { float: footnote; font-size: 0.85em; }`,
    `.paged-doc ::footnote-call { content: counter(footnote); vertical-align: super; font-size: 0.7em; color: var(--doc-brand); line-height: 0; }`,
    `.paged-doc ::footnote-marker { content: counter(footnote) ". "; font-weight: 600; color: var(--doc-brand); }`
  ].join('\n')
}

// — blocks (images / code / blockquote) ——————————————————————————————

function blockBlock(theme: DocTheme): string {
  const { imageRadius, imageMaxWidth, codeBlockTheme, blockquoteStyle } = theme.blocks
  return [
    `.paged-doc img {
  max-width: ${imageMaxWidth}%;
  height: auto;
  border-radius: ${imageRadius}px;
  margin: 0.8em 0;
}`,
    codeBlockCss(codeBlockTheme),
    blockquoteCss(blockquoteStyle)
  ].join('\n')
}

function codeBlockCss(variant: DocTheme['blocks']['codeBlockTheme']): string {
  const monoStack = `ui-monospace, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace`
  const inlineCode = `.paged-doc :not(pre) > code {
  font-family: ${monoStack};
  font-size: 0.88em;
  padding: 0.1em 0.35em;
  border-radius: 3px;
  background: color-mix(in srgb, var(--doc-text) 8%, transparent);
}`
  if (variant === 'none') {
    return [
      inlineCode,
      `.paged-doc pre {
  font-family: ${monoStack};
  font-size: 0.88em;
  margin: 1em 0;
  padding: 0.5em 0;
}`
    ].join('\n')
  }
  const dark = variant === 'dark'
  return [
    inlineCode,
    `.paged-doc pre {
  font-family: ${monoStack};
  font-size: 0.85em;
  background: ${dark ? '#0f172a' : '#f8fafc'};
  color: ${dark ? '#e2e8f0' : 'inherit'};
  border: 1px solid ${dark ? '#1e293b' : '#e2e8f0'};
  border-radius: 4px;
  padding: 0.8em 1em;
  margin: 1em 0;
  overflow-x: auto;
}`,
    `.paged-doc pre code { background: none; padding: 0; }`
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
  return `family=${name.trim().replace(/ /g, '+')}:wght@400;500;600;700`
}
