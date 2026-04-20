/**
 * Per-document theme. Drives both the live paged preview and the printed PDF
 * via a single shared `themeToCss(theme)` function.
 *
 * The shape is intentionally granular: separate `body` / `headings` blocks,
 * dedicated `tables` and `code` sections, so users can tune each surface
 * without touching unrelated knobs. The cost is more validator code and a
 * larger editor panel — the win is themes that actually express
 * publication-grade design.
 */

export type PageSize = 'A4' | 'Letter' | 'Legal'
export type PageOrientation = 'portrait' | 'landscape'
export type ColumnCount = 1 | 2 | 3
export type TextAlign = 'left' | 'justify'
export type BlockquoteStyle = 'border' | 'background' | 'none'
export type HeadingWeight = 400 | 500 | 600 | 700 | 800 | 900

/**
 * Pre-curated highlight.js stylesheet. Maps to a single CDN URL via
 * `shared/utils/hljsCdn.ts`. Adding more is a matter of (a) adding the
 * variant here, (b) extending the URL map, (c) extending the validator
 * allow-list, (d) adding an i18n label.
 */
export type CodeTheme =
  | 'github-light'
  | 'github-dark'
  | 'monokai'
  | 'dracula'
  | 'solarized-light'
  | 'solarized-dark'
  | 'none'

export type TableHeaderBg = 'brand' | 'muted' | 'none'
/** `auto` picks black/white based on the chosen header bg's luminance. */
export type TableHeaderColor = 'auto' | 'inherit'
export type TableBorders = 'all' | 'horizontal' | 'minimal' | 'none'

/**
 * Mermaid's built-in visual themes. Applied via `mermaid.initialize()`
 * in the iframe bootstrap before each render.
 */
export type MermaidTheme = 'default' | 'dark' | 'forest' | 'neutral' | 'base'

/** Visual style of the dotted leader between TOC entry and page number. */
export type TocLeaderStyle = 'dotted' | 'dashed' | 'none'

/** Maximum heading depth shown in the auto-TOC (h1 through h{n}). */
export type TocMaxDepth = 2 | 3 | 4

/**
 * Header/footer slot. Templates support these tokens:
 *   {title}  → document title
 *   {page}   → current page number
 *   {pages}  → total page count
 *   {date}   → today's date (ISO YYYY-MM-DD)
 * Empty string disables the slot.
 */
export type RunningSlots = {
  left: string
  center: string
  right: string
}

export type DocTheme = {
  page: {
    size: PageSize
    orientation: PageOrientation
    margin: number             // mm — uniform on all four sides
  }
  body: {
    font: string               // CSS font-family value (e.g. "Inter")
    size: number               // pt
    lineHeight: number         // unitless multiplier
    textAlign: TextAlign
    color: string              // hex
    background: string         // hex
  }
  headings: {
    font: string
    scale: number              // modular ratio (1.2 / 1.25 / 1.333)
    weight: HeadingWeight
    underline: boolean         // border-bottom in brand color
    color: string              // hex — independent so users can pick brand color for headings
  }
  color: {
    brand: string              // hex; used for links + accent borders + (optionally) heading underline
  }
  layout: {
    columns: ColumnCount
    columnGap: number          // mm
  }
  header: RunningSlots
  footer: RunningSlots
  code: {
    theme: CodeTheme
    fontSize: number           // pt — separate from body so code can be tighter
  }
  tables: {
    headerBackground: TableHeaderBg
    headerTextColor: TableHeaderColor
    borders: TableBorders
    zebra: boolean             // alternating row backgrounds
    cellPadding: number        // px
  }
  blocks: {
    imageRadius: number        // px
    imageMaxWidth: number      // % of column width
    blockquoteStyle: BlockquoteStyle
  }
  mermaid: {
    theme: MermaidTheme
  }
  toc: {
    maxDepth: TocMaxDepth         // include h1 through h{maxDepth}
    showPageNumbers: boolean      // print-style page nums via paged.js target-counter
    leaderStyle: TocLeaderStyle   // line between entry and page number
  }
}
