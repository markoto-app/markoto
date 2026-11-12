import type { DocTheme } from '../types/theme'
import { pageHeightMm } from '../utils/theme/pageDimensions'
import { resolvePageMargins } from '../utils/theme/themeOptions'

// KaTeX math and Mermaid diagrams.

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
export function katexBlock(theme: DocTheme): string {
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

/**
 * Mermaid diagrams arrive as `<div class="mermaid"><img data:svg></div>`
 * (atomic for paged.js) and are swapped for the inline SVG after
 * pagination (so their text uses the page's web fonts — see
 * app/utils/markdown/mermaidLoader.ts). Both forms share one sizing rule, so the
 * swap never moves anything: natural size, never wider than the column
 * and never taller than ~45% of the text area — a chart must not eat a
 * whole page. Colours + fonts come from `buildMermaidConfig(theme)`.
 */
export function mermaidBlock(theme: DocTheme): string {
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
