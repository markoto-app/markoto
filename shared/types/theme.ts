import { z } from 'zod'
import { CUSTOM_CSS_MAX_BYTES } from './customCss'
import { THEME_IMAGE_URL_RE } from '../utils/themeImages'
import { isIsoDate } from '../utils/documentLocale'

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
 * Conservative font-name pattern: letters, digits, spaces (every
 * Google / Fontsource family name fits). No quotes or CSS
 * metacharacters: `themeToCss` wraps the name in quotes, so a stray
 * quote would let a payload escape the string.
 */
const FONT_NAME_REGEX = /^[A-Za-z0-9 ]{1,40}$/

/**
 * Header/footer templates render via `themeToCss` which interpolates
 * them directly into CSS `content:` properties. The `SAFE_TEXT` class
 * rejects CSS-escape characters so a payload like `}body{display:none`
 * can't break the whole stylesheet. `{title} / {section} / {page} /
 * {pages} / {date} / {author}` are stripped before the check so authors CAN use them.
 */
const TEMPLATE_TOKEN_REGEX = /\{(?:title|section|author|page|pages|date)\}/g
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

/**
 * Theme image URL (cover logo, header/footer image): empty, an upload
 * path `/api/files/<docId>/<fileId>.<png|jpg|jpeg|gif|webp>`, or a
 * bundled `/markoto-logos/*` asset. These values are interpolated into
 * an HTML attribute and a CSS `url()`, so nothing else is accepted.
 * Whether an upload path belongs to THE document is checked where the
 * document is known (`meta.put`, AI `update_theme`, render time) — see
 * `shared/utils/themeImages.ts`.
 */
const themeImageUrl = z.string().max(500).regex(THEME_IMAGE_URL_RE, 'must be empty or an image uploaded to the document')

const slotTemplate = z.string().max(200).refine(
  (s: string) => TEMPLATE_SAFE_TEXT_REGEX.test(s.replace(TEMPLATE_TOKEN_REGEX, '')),
  { message: String.raw`contains forbidden characters (", \, <, >, newline)` }
)

// ── Enum types (exported so consumers that import them still work) ──────

export const PageSizeSchema = z.enum(['A4', 'A5', 'Letter', 'Legal'])
export type PageSize = z.infer<typeof PageSizeSchema>

export const PageOrientationSchema = z.enum(['portrait', 'landscape'])
export type PageOrientation = z.infer<typeof PageOrientationSchema>

const ColumnCountSchema = z.union([z.literal(1), z.literal(2), z.literal(3)])

export const TextAlignSchema = z.enum(['left', 'justify'])

export const BlockquoteStyleSchema = z.enum(['border', 'background', 'none'])

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

const HeadingWeightSchema = z.union([
  z.literal(400), z.literal(500), z.literal(600),
  z.literal(700), z.literal(800), z.literal(900)
])

/** Any CSS font weight on the 100-step grid (per-level heading weight, cover title weight). */
export const FontWeightSchema = z.number().int().min(100).max(900).multipleOf(100)

export const HeadingStyleSchema = z.enum(['normal', 'italic'])
export type HeadingStyle = z.infer<typeof HeadingStyleSchema>

/** Horizontal alignment of one heading level (IEEE: centred sections). */
export const HeadingAlignSchema = z.enum(['left', 'center'])
export type HeadingAlign = z.infer<typeof HeadingAlignSchema>

/**
 * Look of ONE heading level, overriding the theme-wide heading values
 * for that level only. Every field optional: absent = the scale /
 * `headings.weight` / upright / no small caps. Academic formats need it
 * (arXiv: 12/10/10pt bold sections; IEEE: small-caps h1, italic h2).
 * Spacing around the heading stays line-based (themeToCss).
 */
export const HeadingLevelStyleSchema = z.object({
  /** Font size as a multiple of the body size (replaces the modular scale for this level). */
  size: z.number().min(0.5).max(4).optional(),
  weight: FontWeightSchema.optional(),
  style: HeadingStyleSchema.optional(),
  smallCaps: z.boolean().optional(),
  /** `center` centres the level (number included); absent = left. */
  align: HeadingAlignSchema.optional()
}).strict()
export type HeadingLevelStyle = z.infer<typeof HeadingLevelStyleSchema>

export const HEADING_LEVEL_KEYS = ['h1', 'h2', 'h3', 'h4'] as const
export type HeadingLevelKey = typeof HEADING_LEVEL_KEYS[number]

export const HeadingLevelsSchema = z.object({
  h1: HeadingLevelStyleSchema.optional(),
  h2: HeadingLevelStyleSchema.optional(),
  h3: HeadingLevelStyleSchema.optional(),
  h4: HeadingLevelStyleSchema.optional()
}).strict()
export type HeadingLevels = z.infer<typeof HeadingLevelsSchema>

/**
 * Pre-curated highlight.js stylesheet. Maps to a single same-origin /vendor/ URL via
 * `shared/utils/hljsAssets.ts`. Adding more is a matter of (a) adding
 * the variant here, (b) extending the URL map, (c) adding an i18n
 * label.
 */
export const CodeThemeSchema = z.enum([
  'github-light', 'github-dark', 'monokai', 'dracula',
  'solarized-light', 'solarized-dark', 'none'
])
export type CodeTheme = z.infer<typeof CodeThemeSchema>

/**
 * Code block fill. `auto` (default): the highlight theme's own background
 * for the dark themes, a faint tint of the text colour for the light ones
 * and for `none` — so a block never floats bare on the page. `tint`
 * always tints, `none` leaves the page colour.
 */
export const CodeBackgroundSchema = z.enum(['auto', 'tint', 'none'])
export type CodeBackground = z.infer<typeof CodeBackgroundSchema>

/** Code block frame: nothing, an accent rule on the left, or a hairline box. */
export const CodeFrameSchema = z.enum(['none', 'rule', 'box'])
export type CodeFrame = z.infer<typeof CodeFrameSchema>

/**
 * Heading numbers on h1–h4 (also in the TOC):
 *  - `none`
 *  - `decimal`     — `1`, `1.1`, `1.1.1`, `1.1.1.1`
 *  - `decimal-dot` — `1.`, `1.1.`, `1.1.1.`, `1.1.1.1.` (legal / German style)
 *  - `ieee`        — `I.`, `A.`, `1)`, `a)` (IEEEtran: each level shows its own number only)
 *  - `decimal-zero` — `01`, `01.1`, `01.1.1`, … (two-digit top level: proposals, brochures)
 * The levels count from the highest heading level the document uses: a
 * document whose sections are h2 numbers them `1`, `2`, … (not `0.1`).
 */
export const HeadingNumberingSchema = z.enum(['none', 'decimal', 'decimal-dot', 'ieee', 'decimal-zero'])
export type HeadingNumbering = z.infer<typeof HeadingNumberingSchema>

/** How many heading levels show a number (1 = only the top level), counted from the highest numbered level. */
export const NumberingDepthSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
export type NumberingDepth = z.infer<typeof NumberingDepthSchema>

/**
 * Chapter word before the top-level number ("Chapter", "Kapitel"). Plain
 * text, interpolated into a CSS string: no quotes, backslashes, angle
 * brackets or newlines.
 */
const chapterWord = z.string().max(40).regex(TEMPLATE_SAFE_TEXT_REGEX, String.raw`contains forbidden characters (", \, <, >, newline)`)

/**
 * Figure / table numbers: through the document (`1`, `2`, …) or within
 * each top-level section (`3.1`, `3.2`, … — theses, books).
 */
export const CaptionNumberingSchema = z.enum(['document', 'chapter'])
export type CaptionNumbering = z.infer<typeof CaptionNumberingSchema>

/**
 * Caption label layout: `inline` = "Table 1: Title"; `stacked` = a bold
 * "Table 1" on its own line, the title below it without separator (APA).
 */
export const CaptionLabelStyleSchema = z.enum(['inline', 'stacked'])
export type CaptionLabelStyle = z.infer<typeof CaptionLabelStyleSchema>

/**
 * How the cover date and the `{date}` token are written: `locale` = the
 * document language's long date (29 October 2026 / 29. Oktober 2026),
 * `us` = US English (October 29, 2026), `iso` = 2026-10-29.
 */
export const DateFormatSchema = z.enum(['locale', 'us', 'iso'])
export type DateFormat = z.infer<typeof DateFormatSchema>

/**
 * `{section}` reads the section heading that is `first` on the page (else
 * the one running on), or the one the page `start`s in (the heading only
 * when it opens the page — the usual running head).
 */
export const SectionModeSchema = z.enum(['first', 'start'])
export type SectionMode = z.infer<typeof SectionModeSchema>

/** Drop cap: off, on the document's first paragraph, or on the first paragraph of every top-level section. */
export const DropCapSchema = z.union([z.boolean(), z.literal('every-chapter')])

export const TableHeaderBgSchema = z.enum(['brand', 'muted', 'none'])

/** `auto` picks black/white based on the chosen header bg's luminance. */
export const TableHeaderColorSchema = z.enum(['auto', 'inherit'])

export const TableBordersSchema = z.enum(['all', 'horizontal', 'minimal', 'none'])

/** Where a table caption (`Table: …` in the Markdown) sits. */
export const CaptionPositionSchema = z.enum(['above', 'below'])
export type CaptionPosition = z.infer<typeof CaptionPositionSchema>

/**
 * Look of the reference list — the section headed References /
 * Bibliography / Literatur / Références … (`app/utils/references.ts`):
 *  - `plain`    — like any other list / paragraphs
 *  - `hanging`  — hanging indent (author-year lists, APA)
 *  - `brackets` — numbered lists get `[1]`, `[2]` labels (IEEE); paragraphs hang
 */
export const ReferenceStyleSchema = z.enum(['plain', 'hanging', 'brackets'])
export type ReferenceStyle = z.infer<typeof ReferenceStyleSchema>

/**
 * Diagram colours. `document` (the default for new themes) derives every
 * colour from the theme itself — accent, heading ink, text, neutral and
 * paper, incl. the pie / xy-chart palettes (`shared/utils/mermaidConfig.ts`).
 * The others are Mermaid's built-in themes, kept for an explicit choice.
 * Diagram text always uses the body font.
 */
export const MermaidThemeSchema = z.enum(['document', 'default', 'dark', 'forest', 'neutral', 'base'])
export type MermaidTheme = z.infer<typeof MermaidThemeSchema>

/** Visual style of the dotted leader between TOC entry and page number. */
export const TocLeaderStyleSchema = z.enum(['dotted', 'dashed', 'none'])
export type TocLeaderStyle = z.infer<typeof TocLeaderStyleSchema>

/** Maximum heading depth shown in the auto-TOC (h1 through h{n}). */
export const TocMaxDepthSchema = z.union([z.literal(2), z.literal(3), z.literal(4)])
export type TocMaxDepth = z.infer<typeof TocMaxDepthSchema>

/**
 * Cover-page composition mode. Each layout is implemented via CSS Grid
 * placement (NOT just `justify-content`) so the visual difference is
 * obvious with even short cover content. See `coverBlock` in
 * `themeToCss.ts`.
 *
 *  - `classic`   — everything stacked vertically + horizontally centered (book/novel feel)
 *  - `editorial` — logo at top, title+subtitle at the upper third, author/date at the lower third (markoto default)
 *  - `banner`    — logo + title in a top band on a brand-tinted stripe, meta at bottom
 *  - `minimal`   — just title (and optional subtitle) centered, no logo/meta even when toggled on
 *  - `title-block` — no cover PAGE: title, subtitle, authors (with
 *                  affiliations), date and the abstract sit at the top of
 *                  page 1 and the text starts right below (papers). The
 *                  abstract is the document's own `Abstract` section — see
 *                  `app/utils/titleBlock.ts`.
 */
export const CoverLayoutSchema = z.enum(['classic', 'editorial', 'banner', 'minimal', 'title-block'])

/**
 * Cover text alignment. Drives `text-align` and the horizontal alignment
 * inside the layout's grid track.
 */
const CoverAlignSchema = z.enum(['left', 'center', 'right'])

/**
 * Header image position. Renders into the corresponding `@top-X` margin
 * box on every BODY page; the cover page's named `@page cover-page`
 * already nulls these so it stays clean.
 */
const HeaderImagePositionSchema = z.enum(['left', 'center', 'right'])

/**
 * Header/footer slot. Templates support these tokens:
 *   {title}  → document title
 *   {section} → the current top-level section heading (the first one
 *              that starts on the page, else the one running on;
 *              `header.sectionMode` / `header.sectionNumber`)
 *   {author} → the cover authors, comma-separated
 *   {page}   → current page number
 *   {pages}  → total page count
 *   {date}   → the publication date (`cover.date`, else today), written
 *              out in the document language
 * Empty string disables the slot.
 */
export const RunningSlotsSchema = z.object({
  left: slotTemplate,
  center: slotTemplate,
  right: slotTemplate,
  /**
   * Optional image rendered in ONE of the three slots (driven by
   * `imagePosition`). Empty string = no image. Mutually exclusive with
   * the text in the same slot — image wins when both are set, since
   * users typically pick one mental model. Cover page suppresses
   * margin boxes entirely so this never appears on the cover.
   */
  imageUrl: themeImageUrl,
  imagePosition: HeaderImagePositionSchema,
  /**
   * Image height in pt (running headers are sized in pt, not px, so
   * they line up with the margin-box font sizes elsewhere). 6–24pt
   * keeps it proportionate to typical 9–11pt header text.
   */
  imageHeight: z.number().int().min(6).max(24),
  /**
   * A thin rule (0.4pt, text colour) across the full text width, right
   * under the running header / right above the footer. With the rule
   * the running text moves next to the text block (the rule sits a
   * fixed `runningRuleGap` away from it). Optional: absent = no rule.
   * Never drawn on pages without running text (cover, title-block page 1).
   */
  rule: z.boolean().optional()
}).strict()
export type RunningSlots = z.infer<typeof RunningSlotsSchema>

/**
 * The header carries the document-wide options of the `{section}` token
 * (they apply wherever the token is used, header or footer).
 */
const HeaderSlotsSchema = RunningSlotsSchema.extend({
  /** `{section}` shows the section number before the title ("3 Procedures"). Optional: absent = title only. */
  sectionNumber: z.boolean().optional(),
  /** Which section heading `{section}` names (`SectionModeSchema`). Optional: absent = `first`. */
  sectionMode: SectionModeSchema.optional()
}).strict()

// ── DocTheme ────────────────────────────────────────────────────────────

export const DocThemeSchema = z.object({
  page: z.object({
    size: PageSizeSchema,
    orientation: PageOrientationSchema,
    // mm — uniform on all four sides. Bounded so a payload can't push
    // e.g. `margin: 1e9` and crash paged.js.
    margin: z.number().min(0).max(60),
    /**
     * Per-side margins in mm, each overriding `margin` for its side
     * (formats with a deeper bottom or binding margin: IEEE 51 / 69 pt).
     * Optional: absent = `margin`.
     */
    marginTop: z.number().min(0).max(60).optional(),
    marginRight: z.number().min(0).max(60).optional(),
    marginBottom: z.number().min(0).max(60).optional(),
    marginLeft: z.number().min(0).max(60).optional(),
    /**
     * Book spreads: left (verso) pages swap the left and right margins, so
     * `marginLeft` is the inside (binding) margin on every page. Optional:
     * absent = the same margins on every page.
     */
    mirrorMargins: z.boolean().optional()
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
     * Drop cap on the first paragraph of the document (`true`), or on
     * the first paragraph of every top-level section (`'every-chapter'`). Editorial
     * signature — gives the page a "first chapter of a book" feel.
     * Renders the leading character at ~3.4× body size, floated left
     * over the first three lines. Uses the heading font + heading
     * colour so it reads as a typographic flourish rather than a
     * brand stamp.
     */
    dropCap: DropCapSchema,
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
    spacingScale: z.number().min(0.5).max(2),
    /**
     * Section numbers on h1–h4 (`1`, `1.1`, …), also shown in the TOC.
     * Optional: themes stored before the field existed read as `none`.
     */
    numbering: HeadingNumberingSchema.optional(),
    /**
     * Per-level overrides (h1–h4): size, weight, italic, small caps.
     * Optional: absent / empty = every level follows the scale and
     * `weight` above.
     */
    levels: HeadingLevelsSchema.optional(),
    /** Levels that show a number (`NumberingDepthSchema`). Optional: absent = 4 (all). */
    numberingDepth: NumberingDepthSchema.optional(),
    /**
     * "Chapter 3" over every numbered top-level heading (with numbering
     * on), on a line of its own. Optional: absent = off.
     */
    chapterLabel: z.boolean().optional(),
    /** The chapter word; empty / absent = the document language's ("Chapter", "Kapitel", "第…章"). */
    chapterWord: chapterWord.optional()
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
   * inline doc images), or a bundled `/markoto-logos/*` asset for the
   * built-in presets. See `themeImageUrl` above.
   */
  brand: z.object({
    logoUrl: themeImageUrl,
    logoHeight: z.number().int().min(8).max(80) // px, on cover
  }).strict(),
  layout: z.object({
    columns: ColumnCountSchema,
    columnGap: z.number().min(0).max(30) // mm
  }).strict(),
  header: HeaderSlotsSchema,
  footer: RunningSlotsSchema,
  code: z.object({
    theme: CodeThemeSchema,
    // pt — separate from body so code can be tighter
    fontSize: z.number().min(6).max(16),
    // The fields below are optional: themes stored before they existed
    // render with the defaults in `shared/utils/themeOptions.ts`.
    /** Code font; absent = the system monospace stack. */
    font: fontName.optional(),
    background: CodeBackgroundSchema.optional(),
    frame: CodeFrameSchema.optional(),
    /** Wrap long lines instead of clipping them at the page edge (default on). */
    wrap: z.boolean().optional(),
    /** Line numbers in the left gutter of every code block (default off). */
    lineNumbers: z.boolean().optional()
  }).strict(),
  tables: z.object({
    headerBackground: TableHeaderBgSchema,
    headerTextColor: TableHeaderColorSchema,
    borders: TableBordersSchema,
    zebra: z.boolean(),
    cellPadding: z.number().int().min(0).max(24), // px
    /** Table caption above (default) or below the table. */
    captionPosition: CaptionPositionSchema.optional(),
    /** "Table 1: " before every caption, in the document language (default off). */
    captionLabel: z.boolean().optional()
  }).strict(),
  blocks: z.object({
    imageRadius: z.number().min(0).max(32), // px
    imageMaxWidth: z.number().min(10).max(100), // % of column width
    blockquoteStyle: BlockquoteStyleSchema,
    hrStyle: HrStyleSchema,
    // Stroke width for rule/dashed/dotted variants. Ignored by
    // asterism + none (they don't draw a border). 1-6 px keeps it
    // proportionate to typical body sizes.
    hrThickness: z.number().int().min(1).max(6),
    /** "Figure 1: " before every figure caption, in the document language (default off). */
    figureLabel: z.boolean().optional(),
    /** Look of the reference list (default `plain`). */
    referenceStyle: ReferenceStyleSchema.optional(),
    /** Figure / table numbers through the document or per chapter (default `document`). */
    captionNumbering: CaptionNumberingSchema.optional(),
    /** Caption label on the title's line or above it (default `inline`). */
    captionLabelStyle: CaptionLabelStyleSchema.optional()
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
    /** Horizontal text alignment + content alignment within the layout. */
    align: CoverAlignSchema,
    showTitle: z.boolean(),
    showSubtitle: z.boolean(),
    /** Free-form subtitle text rendered under the title. */
    subtitle: z.string().max(200),
    showDate: z.boolean(),
    /**
     * Publication date the author picked (`YYYY-MM-DD`), shown on the
     * cover and by the `{date}` header/footer token, written out in the
     * document language (`shared/utils/documentLocale.ts`). Empty or
     * absent = the render date ("today"). Optional so themes stored
     * before the field existed stay valid.
     */
    date: z.string().refine(v => v === '' || isIsoDate(v), { message: 'must be empty or a date (YYYY-MM-DD)' }).optional(),
    /** How the date is written (`DateFormatSchema`). Optional: absent = `locale`. */
    dateFormat: DateFormatSchema.optional(),
    /**
     * Repeat the title (bold, centred) at the top of the first text page
     * after a title page (APA). Optional: absent = off.
     */
    repeatTitle: z.boolean().optional(),
    showAuthors: z.boolean(),
    /**
     * Multi-author list. We're a collaboration tool, so this is an
     * array — each entry rendered on its own line. Cap of 10 authors
     * keeps the cover from becoming a credit roll.
     */
    authors: z.array(z.string().max(100)).max(10),
    /**
     * Affiliation per author, same order as `authors` (department,
     * institution, address, e-mail — one per line). Shown under each
     * author on every layout. Optional (absent = none).
     */
    affiliations: z.array(z.string().max(300)).max(10).optional(),
    /** `title-block`: a heavy rule above and below the title (arXiv style). */
    rules: z.boolean().optional(),
    /** Title (and subtitle) in small capitals. */
    smallCaps: z.boolean().optional(),
    /**
     * Weight of the cover / title-block title (all layouts). Optional:
     * absent = `headings.weight` (the title follows the headings).
     */
    titleWeight: FontWeightSchema.optional(),
    /** Whether to render `theme.brand.logoUrl` on the cover. */
    showLogo: z.boolean(),
    /**
     * Title font size as an em multiplier of the body font size. 0.6–4.0
     * lets users go from quiet/minimal cover titles to oversized display
     * lockups without leaving sensible bounds. The default 2.4 matches
     * the original hardcoded value.
     */
    titleSize: z.number().min(0.6).max(4),
    /** Subtitle em multiplier — same intent as titleSize, smaller range. */
    subtitleSize: z.number().min(0.5).max(2.5)
  }).strict(),
  /**
   * Optional user-authored CSS appended AFTER the generated theme CSS,
   * so its rules win. Documents only (preview, print, server PDF/PNG) —
   * never the app chrome. Stored as typed (formatting kept).
   *
   * The schema bounds the length only (UTF-16 units; the byte cap is in
   * the sanitizer). The content check is `shared/utils/customCss.ts`:
   * write paths reject on any issue, and every render path sanitizes
   * again because `ymeta.theme` can be written directly over Y.js. The
   * schema deliberately does NOT run the parser, so clients can validate
   * an incoming `ymeta.theme` without loading it.
   */
  customCss: z.string().max(CUSTOM_CSS_MAX_BYTES).optional()
}).strict()

export type DocTheme = z.infer<typeof DocThemeSchema>
