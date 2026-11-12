import type { DocTheme } from '../types/theme'
import { resolveCodeOptions } from '../utils/theme/themeOptions'
import { HLJS_THEME_COLORS } from '../utils/vendor/hljsAssets'

// Code blocks and inline code: font, highlight theme fill, frame, wrapping,
// line numbers, fence titles.

const SYSTEM_MONO_STACK = `ui-monospace, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace`

export function codeFontStack(theme: DocTheme): string {
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
export const CODE_KEEP_TOGETHER_LINES = 15

/**
 * Code blocks: one box for every highlight theme. The `<pre>` carries the
 * fill, frame, padding and radius; the highlight.js stylesheet only
 * colours tokens (its own `.hljs` padding/background/overflow are
 * neutralised). Fill (`code.background`): dark highlight themes always
 * keep their own background (their token colours need it); light ones
 * use their background when it isn't white (solarized), else a faint
 * tint of the text colour, so a block never floats bare on the page.
 * Frame (`code.frame`): an accent rule on the left or a hairline box.
 * Long lines wrap (`code.wrap`, default on, a page can't scroll). Line numbers
 * (`code.lineNumbers`) come from each line's `data-line`. A fence title
 * (```ts title="replay.ts") renders as a caption bar above the block.
 */
export function codeBlock(theme: DocTheme): string {
  const monoStack = codeFontStack(theme)
  const { theme: codeTheme, fontSize } = theme.code
  const opts = resolveCodeOptions(theme)
  const box = codeBox(theme)
  const padY = box.filled || opts.frame !== 'none' ? '0.75em' : '0.25em'
  const gutter = opts.lineNumbers ? '3.2em' : box.padX
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
    // Inline code is always lightly tinted regardless of code theme, it
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
  padding: ${padY} ${box.padX} ${padY} ${gutter};
  background: ${box.fill};
  color: ${box.ink};${frameCss(opts.frame, box)}
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
    opts.lineNumbers ? LINE_NUMBERS_CSS : '',
    codeTitleCss(box, monoStack, fontSize, opts.frame)
  ].filter(Boolean).join('\n')
}

type CodeFrame = ReturnType<typeof resolveCodeOptions>['frame']

/** The `<pre>` box: fill and ink from the highlight theme, corner radius, horizontal padding. */
interface CodeBox {
  fill: string
  ink: string
  /** The highlight theme is a dark one (keeps its own background). */
  dark: boolean
  filled: boolean
  radius: number
  padX: string
}

function codeBox(theme: DocTheme): CodeBox {
  const codeTheme = theme.code.theme
  const opts = resolveCodeOptions(theme)
  const colors = codeTheme === 'none' ? null : HLJS_THEME_COLORS[codeTheme]
  const { fill, ink } = codeFill(colors, opts.background)
  const filled = fill !== 'transparent'
  return {
    fill,
    ink,
    dark: colors?.dark ?? false,
    filled,
    radius: Math.min(6, Math.max(2, theme.blocks.imageRadius)),
    padX: filled || opts.frame !== 'none' ? '0.9em' : '0'
  }
}

/** Fill per `code.background` (see `codeBlock`); dark highlight themes always keep their own. */
function codeFill(
  colors: (typeof HLJS_THEME_COLORS)[keyof typeof HLJS_THEME_COLORS] | null,
  background: ReturnType<typeof resolveCodeOptions>['background']
): { fill: string, ink: string } {
  if (colors?.dark) return { fill: colors.background, ink: colors.color }
  if (background === 'none') return { fill: 'transparent', ink: 'inherit' }
  if (background === 'tint' || !colors || colors.background === '#ffffff') {
    return { fill: 'color-mix(in srgb, var(--doc-text) 5%, var(--doc-bg))', ink: 'inherit' }
  }
  return { fill: colors.background, ink: 'inherit' }
}

function frameCss(frame: CodeFrame, { radius, filled }: CodeBox): string {
  if (frame === 'rule') return `\n  border-left: 3px solid var(--doc-brand);\n  border-radius: 0 ${radius}px ${radius}px 0;`
  if (frame === 'box') return `\n  border: 0.75pt solid color-mix(in srgb, var(--doc-secondary) 70%, transparent);\n  border-radius: ${radius}px;`
  return `\n  border-radius: ${filled ? radius : 0}px;`
}

const LINE_NUMBERS_CSS = `.paged-doc pre .code-line::before {
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

/** Caption from the fence's `title="…"`: a small bar glued to the block. */
function codeTitleCss(box: CodeBox, monoStack: string, fontSize: number, frame: CodeFrame): string {
  const { fill, ink, dark, filled, radius, padX } = box
  const rule = dark ? `color-mix(in srgb, ${fill} 70%, #ffffff)` : 'color-mix(in srgb, var(--doc-secondary) 45%, transparent)'
  const background = filled ? (dark ? `color-mix(in srgb, ${fill} 88%, #ffffff)` : fill) : 'transparent'
  const color = dark ? `\n  color: color-mix(in srgb, ${ink} 75%, ${fill});` : ''
  return `.paged-doc .code-block { margin: 1em 0; }
.paged-doc .code-block > pre { margin-top: 0; }
.paged-doc .code-title {
  font-family: ${monoStack};
  font-size: ${Math.max(6, fontSize - 1)}pt;
  color: var(--doc-secondary);
  padding: 0.35em ${padX === '0' ? '0' : '0.9em'};
  border-bottom: 0.75pt solid ${rule};
  background: ${background};${color}
  border-radius: ${filled || frame === 'box' ? `${radius}px ${radius}px 0 0` : '0'};
  break-after: avoid;
}
.paged-doc .code-title + pre { border-top-left-radius: 0; border-top-right-radius: 0; }`
}
