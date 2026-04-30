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

/**
 * `<hr>` rendering. Markdown source `---` produces an `<hr>`; what we
 * draw between the surrounding paragraphs is the editorial voice.
 *  - `rule`     — solid horizontal line (the default print look)
 *  - `dashed`   — dashed line (drier, quieter)
 *  - `dotted`   — dotted line
 *  - `asterism` — Unicode `⁂` glyph centered (literary/editorial)
 *  - `none`     — invisible separator (still consumes vertical space)
 */
export const HrStyleSchema = z.enum(['rule', 'dashed', 'dotted', 'asterism', 'none'])
export type HrStyle = z.infer<typeof HrStyleSchema>

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
 * Cover-page composition mode.
 *  - `centered` — all content vertically + horizontally centered (book/novel)
 *  - `top`      — title block top-aligned, rest of page blank (technical reports)
 *  - `split`    — title block top, author/date bottom (academic / business)
 */
export const CoverLayoutSchema = z.enum(['centered', 'top', 'split'])
export type CoverLayout = z.infer<typeof CoverLayoutSchema>

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
  /**
   * Optional third font slot — the "eyebrow / meta" voice. Used for
   * header/footer text, figcaptions, footnotes and any other
   * "metadata about the document" surface where Inter body or
   * Fraunces editorial would feel out of place. Markoto's brand
   * uses JetBrains Mono here. Falls back to body font when unset.
   */
  meta: z.object({
    font: fontName
  }).strict(),
  body: z.object({
    font: fontName,
    size: z.number().min(6).max(24), // pt
    lineHeight: z.number().min(0.8).max(3), // unitless multiplier
    textAlign: TextAlignSchema,
    color: hexColor,
    background: hexColor,
    /**
     * Drop cap on the first paragraph of the document. Editorial
     * signature — gives the page a "first chapter of a book" feel.
     * Renders the leading character at ~3.4× body size, floated left
     * over the first three lines. Uses the heading font + heading
     * colour so it reads as a typographic flourish rather than a
     * brand stamp.
     */
    dropCap: z.boolean(),
    /**
     * Indent the first line of every paragraph EXCEPT the first one in
     * a sequence (typical novel typography). When true, prefer setting
     * `paragraphSpacing` low (≤0.2em) so paragraphs read as continuous
     * prose, not bulleted blocks.
     */
    firstLineIndent: z.boolean(),
    /**
     * Vertical margin between paragraphs in em. 0.6em is the print
     * default; novels often go lower (0.2em) when first-line indent
     * carries the visual break; reports/newsletters go higher (1.0em+).
     */
    paragraphSpacing: z.number().min(0).max(2),
    /**
     * Auto-hyphenation for body text. Decoupled from `textAlign` so
     * left-ragged themes can still hyphenate (some prefer this) and
     * justified themes can disable hyphenation if they don't mind
     * word-spacing rivers.
     */
    hyphenate: z.boolean()
  }).strict(),
  headings: z.object({
    font: fontName,
    scale: z.number().min(1).max(2), // modular ratio (1.2 / 1.25 / 1.333)
    weight: HeadingWeightSchema,
    underline: z.boolean(), // border-bottom in brand color
    color: hexColor,
    /**
     * Heading letter-spacing in em. Fraunces and other display serifs
     * read better with slight negative tracking (-0.01em); geometric
     * sans (Inter, IBM Plex) tolerate 0; condensed display faces want
     * positive tracking (+0.02em). Range -0.05 to 0.1.
     */
    letterSpacing: z.number().min(-0.05).max(0.1),
    /**
     * Heading line-height multiplier. Print-typical is 1.2 (current
     * default); larger heading sizes (Fraunces at 32pt+) read better
     * with 1.15-1.25.
     */
    lineHeight: z.number().min(0.9).max(1.6),
    /**
     * Multiplier on the heading top-margin. 1.0 = current behaviour
     * (h1/h2 = 1.4em, h3+ = 1.0em). 1.2 = editorial breathing room;
     * 0.7 = tight reports. Range 0.5–2.0.
     */
    spacingScale: z.number().min(0.5).max(2)
  }).strict(),
  color: z.object({
    // hex; used for links + accent borders + (optionally) heading underline
    brand: hexColor,
    /**
     * Muted neutral hue used for hairlines, dividers, table borders,
     * figcaptions, TOC leader/page-numbers, and footnote rules. Picking
     * the right secondary makes every dim element on the page feel
     * intentional rather than just "alpha-blended body text". Markoto
     * uses sumi-400 (warm muted brown-grey); other presets use a
     * tonally-appropriate mid-grey.
     */
    secondary: hexColor
  }).strict(),
  /**
   * Brand assets — logo image used on the cover page and (eventually)
   * margin-box `{logo}` token. `logoUrl` is empty string when no logo
   * has been uploaded; otherwise it's a `/api/files/{docId}/{fileId}`
   * URL produced by the standard image-upload pipeline (same as
   * inline doc images). Validated as bounded length, not full URL —
   * we accept relative paths since logos live in the doc's own S3
   * namespace.
   */
  brand: z.object({
    logoUrl: z.string().max(500),
    logoHeight: z.number().int().min(8).max(80) // px, on cover
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
    blockquoteStyle: BlockquoteStyleSchema,
    hrStyle: HrStyleSchema,
    // Stroke width for rule/dashed/dotted variants. Ignored by
    // asterism + none (they don't draw a border). 1-6 px keeps it
    // proportionate to typical body sizes.
    hrThickness: z.number().int().min(1).max(6)
  }).strict(),
  mermaid: z.object({
    theme: MermaidThemeSchema
  }).strict(),
  /**
   * GitHub-style admonition palette. One color per kind drives both the
   * left-border and the (color-mixed-into-bg) tint. Required so themes
   * can't fall back to a hardcoded palette that would clash with the
   * brand — every theme commits to its own admonition look.
   *
   * Tradition reserves these hues for these meanings (blue/info,
   * green/tip, purple/important, amber/warning, red/caution); themes
   * are free to break tradition but should at least keep the kinds
   * visually distinct from each other so the meaning reads at a glance.
   */
  alerts: z.object({
    note: hexColor,
    tip: hexColor,
    important: hexColor,
    warning: hexColor,
    caution: hexColor
  }).strict(),
  toc: z.object({
    maxDepth: TocMaxDepthSchema,
    showTitle: z.boolean(),
    showPageNumbers: z.boolean(),
    leaderStyle: TocLeaderStyleSchema
  }).strict(),
  /**
   * Cover page (title sheet). When enabled, a dedicated first page is
   * prepended to the document with title / subtitle / authors / date.
   * The cover suppresses the page header + footer (no page numbers
   * on a title page) by being assigned to a named page (`cover-page`)
   * with empty margin boxes.
   */
  cover: z.object({
    enabled: z.boolean(),
    layout: CoverLayoutSchema,
    showTitle: z.boolean(),
    showSubtitle: z.boolean(),
    /** Free-form subtitle text rendered under the title. */
    subtitle: z.string().max(200),
    showDate: z.boolean(),
    showAuthors: z.boolean(),
    /**
     * Multi-author list. We're a collaboration tool, so this is an
     * array — each entry rendered on its own line. Cap of 10 authors
     * keeps the cover from becoming a credit roll.
     */
    authors: z.array(z.string().max(100)).max(10),
    /**
     * Reserved for Step 10 (logo upload). When true, renders
     * `theme.brand.logo` above the title block. Until Step 10 ships,
     * this is a no-op (no logo source).
     */
    showLogo: z.boolean()
  }).strict()
}).strict()

export type DocTheme = z.infer<typeof DocThemeSchema>
