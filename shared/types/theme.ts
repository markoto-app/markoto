/**
 * Per-document theme. Drives both the live paged preview and the printed PDF
 * via a single shared `themeToCss(theme)` function.
 *
 * Phase 1 ships a hardcoded `defaultTheme`. Phase 2 will add a JSONB column on
 * the documents table and a slide-out editor panel (owner-only) wired through
 * `ymeta.theme` for live broadcast. Phase 3 introduces built-in presets;
 * Phase 4 introduces user-saved themes. The shape here is forward-compatible
 * with all of those — every field is "one knob per concept" by design, no
 * per-element overrides.
 */

export type PageSize = 'A4' | 'Letter' | 'Legal'
export type PageOrientation = 'portrait' | 'landscape'
export type ColumnCount = 1 | 2 | 3
export type CodeBlockTheme = 'light' | 'dark' | 'none'
export type BlockquoteStyle = 'border' | 'background' | 'none'
export type TextAlign = 'left' | 'justify'

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
    margin: number  // mm — uniform on all four sides
  }
  typography: {
    bodyFont: string         // CSS font-family value (e.g. "Inter")
    bodySize: number         // pt
    lineHeight: number       // unitless multiplier
    headingFont: string
    headingScale: number     // modular ratio (1.2 / 1.25 / 1.333)
    headingUnderline: boolean
    textAlign: TextAlign     // 'left' (default) or 'justify' (fill)
  }
  color: {
    brand: string            // hex; used for links + accent borders + heading underline
    text: string
    background: string
  }
  layout: {
    columns: ColumnCount
    columnGap: number        // mm
  }
  header: RunningSlots
  footer: RunningSlots
  blocks: {
    imageRadius: number      // px
    imageMaxWidth: number    // % of column width
    codeBlockTheme: CodeBlockTheme
    blockquoteStyle: BlockquoteStyle
  }
}
