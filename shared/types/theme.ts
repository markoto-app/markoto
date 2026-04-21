import { z } from 'zod'

/**
 * Per-document theme. Drives both the live paged preview and the printed
 * PDF via a single shared `themeToCss(theme)` function.
 *
 * The shape is intentionally granular: separate `body` / `headings`
 * blocks, dedicated `tables` and `code` sections, so users can tune each
 * surface without touching unrelated knobs. The cost is more validator
 * code and a larger editor panel — the win is themes that actually
 * express publication-grade design.
 *
 * The Zod schemas below are the source of truth. `DocTheme` is derived
 * via `z.infer<typeof DocThemeSchema>`, and the meta.put endpoint +
 * server-side code paths validate against these schemas directly
 * (see `shared/utils/themeValidation.ts`). Every range / enum / regex
 * bound lives here, so "what a valid theme looks like" has exactly one
 * definition.
 */

// ── Primitives ──────────────────────────────────────────────────────────

/**
 * Conservative font-name pattern. Google Fonts allows letters, digits,
 * spaces. No quotes or CSS metacharacters: `themeToCss` wraps the name
 * in quotes, so a stray quote would let a payload escape the `family=`
 * URL.
 */
const FONT_NAME_REGEX = /^[A-Za-z0-9 ]{1,40}$/

/**
 * Header/footer templates render via `themeToCss` which interpolates
 * them directly into CSS `content:` properties. The `SAFE_TEXT` class
 * rejects CSS-escape characters so a payload like `}body{display:none`
 * can't break the whole stylesheet. `{title} / {page} / {pages} /
 * {date}` are stripped before the check so authors CAN use them.
 */
const TEMPLATE_TOKEN_REGEX = /\{(?:title|page|pages|date)\}/g
const TEMPLATE_SAFE_TEXT_REGEX = /^[^"\\\n\r<>]*$/

const HEX_COLOR_REGEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/**
 * Exported so non-theme code (e.g. the AI `update_theme` tool schema in
 * `server/utils/agentic/functionTools.ts`) can reuse the same regex
 * rather than maintain a parallel copy that could drift. Any change to
 * what "valid hex" means now propagates automatically.
 */
export const HexColorSchema = z.string().regex(HEX_COLOR_REGEX, 'must be a hex color')
const hexColor = HexColorSchema
const fontName = z.string().regex(FONT_NAME_REGEX, 'must be a valid font name (letters, digits, spaces; 1-40 chars)')

const slotTemplate = z.string().max(200).refine(
  (s: string) => TEMPLATE_SAFE_TEXT_REGEX.test(s.replace(TEMPLATE_TOKEN_REGEX, '')),
  { message: 'contains forbidden characters (", \\, <, >, newline)' }
)

// ── Enum types (exported so consumers that import them still work) ──────

export const PageSizeSchema = z.enum(['A4', 'Letter', 'Legal'])
export type PageSize = z.infer<typeof PageSizeSchema>

export const PageOrientationSchema = z.enum(['portrait', 'landscape'])
export type PageOrientation = z.infer<typeof PageOrientationSchema>

export const ColumnCountSchema = z.union([z.literal(1), z.literal(2), z.literal(3)])
export type ColumnCount = z.infer<typeof ColumnCountSchema>

export const TextAlignSchema = z.enum(['left', 'justify'])
export type TextAlign = z.infer<typeof TextAlignSchema>

export const BlockquoteStyleSchema = z.enum(['border', 'background', 'none'])
export type BlockquoteStyle = z.infer<typeof BlockquoteStyleSchema>

export const HeadingWeightSchema = z.union([
  z.literal(400), z.literal(500), z.literal(600),
  z.literal(700), z.literal(800), z.literal(900)
])
export type HeadingWeight = z.infer<typeof HeadingWeightSchema>

/**
 * Pre-curated highlight.js stylesheet. Maps to a single CDN URL via
 * `shared/utils/hljsCdn.ts`. Adding more is a matter of (a) adding
 * the variant here, (b) extending the URL map, (c) adding an i18n
 * label.
 */
export const CodeThemeSchema = z.enum([
  'github-light', 'github-dark', 'monokai', 'dracula',
  'solarized-light', 'solarized-dark', 'none'
])
export type CodeTheme = z.infer<typeof CodeThemeSchema>

export const TableHeaderBgSchema = z.enum(['brand', 'muted', 'none'])
export type TableHeaderBg = z.infer<typeof TableHeaderBgSchema>

/** `auto` picks black/white based on the chosen header bg's luminance. */
export const TableHeaderColorSchema = z.enum(['auto', 'inherit'])
export type TableHeaderColor = z.infer<typeof TableHeaderColorSchema>

export const TableBordersSchema = z.enum(['all', 'horizontal', 'minimal', 'none'])
export type TableBorders = z.infer<typeof TableBordersSchema>

/**
 * Mermaid's built-in visual themes. Applied via `mermaid.initialize()`
 * in the iframe bootstrap before each render.
 */
export const MermaidThemeSchema = z.enum(['default', 'dark', 'forest', 'neutral', 'base'])
export type MermaidTheme = z.infer<typeof MermaidThemeSchema>

/** Visual style of the dotted leader between TOC entry and page number. */
export const TocLeaderStyleSchema = z.enum(['dotted', 'dashed', 'none'])
export type TocLeaderStyle = z.infer<typeof TocLeaderStyleSchema>

/** Maximum heading depth shown in the auto-TOC (h1 through h{n}). */
export const TocMaxDepthSchema = z.union([z.literal(2), z.literal(3), z.literal(4)])
export type TocMaxDepth = z.infer<typeof TocMaxDepthSchema>

/**
 * Header/footer slot. Templates support these tokens:
 *   {title}  → document title
 *   {page}   → current page number
 *   {pages}  → total page count
 *   {date}   → today's date (ISO YYYY-MM-DD)
 * Empty string disables the slot.
 */
export const RunningSlotsSchema = z.object({
  left: slotTemplate,
  center: slotTemplate,
  right: slotTemplate
}).strict()
export type RunningSlots = z.infer<typeof RunningSlotsSchema>

// ── DocTheme ────────────────────────────────────────────────────────────

export const DocThemeSchema = z.object({
  page: z.object({
    size: PageSizeSchema,
    orientation: PageOrientationSchema,
    // mm — uniform on all four sides. Bounded so a payload can't push
    // e.g. `margin: 1e9` and crash paged.js.
    margin: z.number().min(0).max(60)
  }).strict(),
  body: z.object({
    font: fontName,
    size: z.number().min(6).max(24),      // pt
    lineHeight: z.number().min(0.8).max(3), // unitless multiplier
    textAlign: TextAlignSchema,
    color: hexColor,
    background: hexColor
  }).strict(),
  headings: z.object({
    font: fontName,
    scale: z.number().min(1).max(2), // modular ratio (1.2 / 1.25 / 1.333)
    weight: HeadingWeightSchema,
    underline: z.boolean(), // border-bottom in brand color
    color: hexColor
  }).strict(),
  color: z.object({
    // hex; used for links + accent borders + (optionally) heading underline
    brand: hexColor
  }).strict(),
  layout: z.object({
    columns: ColumnCountSchema,
    columnGap: z.number().min(0).max(30) // mm
  }).strict(),
  header: RunningSlotsSchema,
  footer: RunningSlotsSchema,
  code: z.object({
    theme: CodeThemeSchema,
    // pt — separate from body so code can be tighter
    fontSize: z.number().min(6).max(16)
  }).strict(),
  tables: z.object({
    headerBackground: TableHeaderBgSchema,
    headerTextColor: TableHeaderColorSchema,
    borders: TableBordersSchema,
    zebra: z.boolean(),
    cellPadding: z.number().int().min(0).max(24) // px
  }).strict(),
  blocks: z.object({
    imageRadius: z.number().min(0).max(32), // px
    imageMaxWidth: z.number().min(10).max(100), // % of column width
    blockquoteStyle: BlockquoteStyleSchema
  }).strict(),
  mermaid: z.object({
    theme: MermaidThemeSchema
  }).strict(),
  toc: z.object({
    maxDepth: TocMaxDepthSchema,
    showTitle: z.boolean(),
    showPageNumbers: z.boolean(),
    leaderStyle: TocLeaderStyleSchema
  }).strict()
}).strict()

export type DocTheme = z.infer<typeof DocThemeSchema>
