import { z } from 'zod'
import { CODE_FONT_NAMES, THEME_FONTS } from '~~/shared/utils/theme/themeFonts'
import { THEME_PRESETS } from '~~/shared/utils/theme/themePresets'
import { CUSTOM_CSS_MAX_BYTES } from '~~/shared/types/customCss'
import { CUSTOM_CSS_AI_REFERENCE } from '~~/shared/utils/theme/customCssReference'
import {
  HexColorSchema,
  PageSizeSchema,
  PageOrientationSchema,
  TextAlignSchema,
  CodeThemeSchema,
  TableHeaderBgSchema,
  TableHeaderColorSchema,
  TableBordersSchema,
  BlockquoteStyleSchema,
  MermaidThemeSchema,
  TocLeaderStyleSchema,
  HrStyleSchema,
  CoverLayoutSchema,
  CodeBackgroundSchema,
  CodeFrameSchema,
  HeadingNumberingSchema,
  FontWeightSchema,
  HeadingStyleSchema,
  HeadingAlignSchema,
  CaptionPositionSchema,
  ReferenceStyleSchema,
  CaptionNumberingSchema,
  CaptionLabelStyleSchema,
  DateFormatSchema,
  SectionModeSchema,
  DropCapSchema
} from '~~/shared/types/theme'

// The `update_theme` argument schema: a partial theme patch. Also the MCP
// `update_theme` input and the schema the design import asks the vision
// model to fill, so all three accept the same fields.

// update_theme: partial theme patch. Every leaf is optional and every sub-object is
// optional — the AI only sends what it wants to change, the handler
// deep-merges over the current theme. Enums + ranges mirror
// `isValidTheme` exactly so the AI's schema advertises the same
// valid-value surface the validator enforces at runtime.
//
// Fonts are pinned to the curated, self-hosted list in `themeFonts.ts`:
// those are the only families themeToCss actually fetches, so letting
// the AI choose "Times New Roman" or similar would render as a system
// fallback rather than the classic serif the user asked for. Closest
// matches from the curated list (PT Serif, EB Garamond, Libre
// Baskerville, etc.) still get the typographic effect the user wants.

// FONT_NAMES is a non-empty tuple, which `z.enum` requires.
//
// Why fonts differ from the other enums in this file: `DocThemeSchema`
// (shared/types/theme.ts) accepts any string matching FONT_NAME_REGEX —
// that's "any CSS-safe font name". This tool intentionally restricts
// the model to the CURATED list of fonts we actually serve
// (via `themeFonts.ts`). If the AI picked "Times New Roman", the
// preview would silently fall back to a system font rather than render
// the serif the user asked for.
const FONT_NAMES = THEME_FONTS.map(f => f.name) as [string, ...string[]]
const PRESET_IDS = THEME_PRESETS.map(p => p.id) as [string, ...string[]]

// The numeric-range and header/footer-template schemas are repeated
// inline below rather than imported from `DocThemeSchema`, because this
// is a PATCH schema — every field is `.optional()` — and the base
// DocThemeSchema's fields are all required. Flipping them via
// `.partial()` on a deeply nested schema would lose the model-friendly
// `.describe()` annotations.
//
// Enum schemas that match 1:1 with DocTheme (page size, orientation,
// text align, code theme, table bgs, borders, blockquote, mermaid
// theme, leader style) ARE imported from theme.ts to keep the valid-
// value surfaces in sync. Adding a new e.g. code theme there now
// automatically extends what the AI can request.

const RunningSlotsPatch = z.object({
  left: z.string().max(200).optional()
    .describe('Header/footer left slot template. Tokens: {title}, {section} (the current top-level section heading — running heads; see header.sectionNumber / header.sectionMode), {author} (the cover authors, comma-separated), {page}, {pages}, {date}. Empty string disables the slot.'),
  center: z.string().max(200).optional().describe('Center slot template; same tokens as left.'),
  right: z.string().max(200).optional().describe('Right slot template; same tokens as left.'),
  rule: z.boolean().optional()
    .describe('Thin rule (0.4pt, text colour) across the full text width: under the header / above the footer, with the running text moved next to it (journal / LaTeX look). Not drawn on the cover or title-block page. Default false.')
})

const HeaderSlotsPatch = RunningSlotsPatch.extend({
  sectionNumber: z.boolean().optional()
    .describe('`{section}` (header or footer) shows the section number before its title ("3 Procedures"); default false = title only. Use with headings.numbering.'),
  sectionMode: SectionModeSchema.optional()
    .describe('Which section `{section}` names: `first` (default) = the first top-level heading on the page; `start` = the section the page starts in (the usual running head).')
})

const HeadingLevelPatch = z.object({
  size: z.number().min(0.5).max(4).optional()
    .describe('Size as a multiple of the body size (0.5–4), replacing the scale for this level. arXiv: h1 1.2, h2 1, h3 1.'),
  weight: FontWeightSchema.optional().describe('Font weight 100–900 in steps of 100 for this level (default: headings.weight).'),
  style: HeadingStyleSchema.optional().describe('`italic` or `normal` (default).'),
  smallCaps: z.boolean().optional().describe('Small capitals for this level (default false).'),
  align: HeadingAlignSchema.optional().describe('`center` centres this level, number included (IEEE sections); `left` (default).')
}).describe('Look of one heading level. Omitted fields follow the theme-wide heading values; `{}` removes every override of the level.')

// Function-call compatibility quirk: numeric theme fields
// (`headings.weight`, `layout.columns`, `toc.maxDepth`) are declared here as
// STRING enums even though DocThemeSchema has them as numeric unions, because
// some providers' function-declaration validators reject `oneOf` with numeric
// literals (only strings). We coerce
// back to a number in `coerceThemePatch` (themeMerge.ts) before the
// merged theme goes through `isValidTheme`. The canonical numeric
// surface lives in theme.ts; don't add a new weight/column/depth
// value without updating both lists.
export const UpdateThemeArgs = z.object({
  preset: z.enum(PRESET_IDS).optional()
    .describe(`Apply a built-in preset as the base, replacing ALL current theme values; the document's own customCss is kept (a preset with template CSS, e.g. arxiv, puts its CSS in front of it). Other fields passed alongside are applied on top of the preset. Available presets: ${PRESET_IDS.join(', ')}. Mutually exclusive with theme_id and from_workspace_default — pass only one base source.`),
  theme_id: z.string().min(1).max(64).optional()
    .describe('Apply one of the user\'s SAVED themes as the base, replacing ALL current theme values. The id comes from `list_themes` — never fabricate it. Other fields in the same call are merged on top. Mutually exclusive with `preset` and `from_workspace_default`.'),
  from_workspace_default: z.boolean().optional()
    .describe('Apply the workspace\'s default theme as the base, replacing ALL current theme values. Errors if the document is not in a workspace OR the workspace has no default set. Mutually exclusive with `preset` and `theme_id`.'),
  page: z.object({
    size: PageSizeSchema.optional(),
    orientation: PageOrientationSchema.optional(),
    margin: z.number().min(0).max(60).optional().describe('Uniform page margin in mm (0–60).'),
    marginTop: z.number().min(0).max(60).optional().describe('Top margin in mm (0–60), overriding `margin` for that side only. Omit to follow `margin`. IEEE conference: top 18, bottom 24.3, sides 16.93.'),
    marginRight: z.number().min(0).max(60).optional().describe('Right margin in mm, overriding `margin`.'),
    marginBottom: z.number().min(0).max(60).optional().describe('Bottom margin in mm, overriding `margin`.'),
    marginLeft: z.number().min(0).max(60).optional().describe('Left margin in mm, overriding `margin`.'),
    mirrorMargins: z.boolean().optional()
      .describe('Book spreads: left-hand pages swap the left and right margins, so marginLeft is the inside (binding) margin. Default false.')
  }).optional(),
  body: z.object({
    font: z.enum(FONT_NAMES).optional()
      .describe('Body text font. Pick the closest curated Google Font to what the user asked for. Falls back to a system serif/sans if the user names something off-list.'),
    size: z.number().min(6).max(24).optional().describe('Body font size in pt (6–24).'),
    lineHeight: z.number().min(0.8).max(3).optional().describe('Unitless line-height multiplier (0.8–3).'),
    textAlign: TextAlignSchema.optional(),
    color: HexColorSchema.optional().describe('Body text color, hex.'),
    background: HexColorSchema.optional().describe('Page background color, hex.'),
    dropCap: DropCapSchema.optional()
      .describe('Drop cap (3.4× body size in heading font, floated left): `true` on the first paragraph, `"every-chapter"` on the first paragraph of every top-level section, `false` none. Editorial signature — pairs naturally with novel/long-form themes.'),
    firstLineIndent: z.boolean().optional()
      .describe('Indent the first line of every paragraph except the first in a sequence. Novel typography — best paired with low paragraphSpacing (≤0.2em).'),
    paragraphSpacing: z.number().min(0).max(2).optional()
      .describe('Vertical margin between paragraphs in em (0–2). 0.6 print default, 0.2 novel-tight, 1.0 newsletter-airy.'),
    hyphenate: z.boolean().optional()
      .describe('Auto-hyphenate body text. Recommended for justified text to avoid word-spacing rivers; fine to disable for left-aligned prose.')
  }).optional(),
  headings: z.object({
    font: z.enum(FONT_NAMES).optional(),
    scale: z.number().min(1).max(2).optional()
      .describe('Ratio between heading levels (1–2): h4 = body size, h3 = body×scale, h2 = body×scale², h1 = body×scale³. 1.2 → h1 1.73× body (papers), 1.25 → 1.95× (reports), 1.28 → 2.1×, 1.333 → 2.37× (airy). Big display sizes belong on the cover (cover.titleSize).'),
    weight: z.enum(['400', '500', '600', '700', '800', '900']).optional()
      .describe('Heading font weight; pass as a string numeric like "600".'),
    underline: z.boolean().optional().describe('Draw a brand-colored underline below headings.'),
    color: HexColorSchema.optional(),
    letterSpacing: z.number().min(-0.05).max(0.1).optional()
      .describe('Heading letter-spacing in em (-0.05 to 0.1). Display serifs (Fraunces) want slight negative tracking (-0.01); geometric sans tolerate 0.'),
    lineHeight: z.number().min(0.9).max(1.6).optional()
      .describe('Heading line-height multiplier (0.9–1.6). 1.2 print default; 1.25 for larger display serifs.'),
    spacingScale: z.number().min(0.5).max(2).optional()
      .describe('Multiplier on the space above headings (0.5–2). 1.0 default; 1.2 editorial breathing; 0.7 tight reports.'),
    numbering: HeadingNumberingSchema.optional()
      .describe('Section numbers before h1–h4 and their TOC entries: `decimal` 1, 1.1, 1.1.1 (reports, papers, specs); `decimal-dot` 1., 1.1., 1.1.1. (legal / German style); `ieee` I., A., 1), a) (IEEE papers: each level shows only its own number); `decimal-zero` 01, 01.1 (proposals, brochures); `none` (default). Numbers count from the highest heading level the document uses (a document whose sections are h2 starts at 1). The cover title, a leading "Abstract" section and headings marked `{.unnumbered}` in the Markdown (`# References {.unnumbered}`) are never numbered and don\'t advance the counters.'),
    levels: z.object({
      h1: HeadingLevelPatch.optional(),
      h2: HeadingLevelPatch.optional(),
      h3: HeadingLevelPatch.optional(),
      h4: HeadingLevelPatch.optional()
    }).optional()
      .describe('Per-level overrides for h1–h4 (size × body, weight, italic, small caps) — for academic formats (arXiv: 12/10/10pt bold; IEEE: small-caps h1, italic h2). Each level you send replaces that level\'s overrides; levels you omit keep theirs.'),
    numberingDepth: z.number().int().min(1).max(4).optional()
      .describe('How many heading levels show a number (1 = chapters only; default 4). Counted from the highest numbered level.'),
    chapterLabel: z.boolean().optional()
      .describe('With numbering on: "Chapter 3" (in the document language) on its own line over every numbered top-level heading (theses, books). Default false.'),
    chapterWord: z.string().max(40).regex(/^[^"\\\n\r<>]*$/).optional()
      .describe('The word for chapterLabel ("Part", "Kapitel"); empty string = the document language\'s word.')
  }).optional(),
  color: z.object({
    brand: HexColorSchema.optional().describe('Brand color used for links, accents, optional heading underline.'),
    secondary: HexColorSchema.optional()
      .describe('Muted neutral hue for hairlines, dividers, table borders, figcaptions, TOC leader, footnote rule. Pick a desaturated tone in the same temperature family as the brand.')
  }).optional(),
  meta: z.object({
    font: z.enum(FONT_NAMES).optional()
      .describe('Eyebrow / meta voice font for header/footer text, figcaptions, footnotes. Often a mono or distinct face for "instrument" feel; can match body for unified themes.')
  }).optional(),
  layout: z.object({
    columns: z.enum(['1', '2', '3']).optional().describe('Column count; pass as string numeric like "2".'),
    columnGap: z.number().min(0).max(30).optional().describe('Gap between columns in mm (0–30).')
  }).optional(),
  header: HeaderSlotsPatch.optional(),
  footer: RunningSlotsPatch.optional(),
  code: z.object({
    theme: CodeThemeSchema.optional(),
    fontSize: z.number().min(6).max(16).optional().describe('Code block font size in pt (6–16).'),
    font: z.enum(CODE_FONT_NAMES).optional()
      .describe('Code font (monospace). Omit for the system monospace stack. "Latin Modern Mono" gives the LaTeX typewriter look.'),
    background: CodeBackgroundSchema.optional()
      .describe('Code block fill for LIGHT code themes: `auto` (default; the theme\'s own background, or a faint tint when it is white), `tint`, `none`. Dark code themes always keep their own background.'),
    frame: CodeFrameSchema.optional()
      .describe('Code block frame: `none` (default), `rule` (accent rule on the left), `box` (hairline border).'),
    wrap: z.boolean().optional().describe('Wrap long code lines (default true; a printed page cannot scroll, unwrapped lines are cut off).'),
    lineNumbers: z.boolean().optional().describe('Line numbers in the gutter of every code block (default false).')
  }).optional(),
  tables: z.object({
    headerBackground: TableHeaderBgSchema.optional(),
    headerTextColor: TableHeaderColorSchema.optional(),
    borders: TableBordersSchema.optional(),
    zebra: z.boolean().optional().describe('Alternating row backgrounds.'),
    cellPadding: z.number().int().min(0).max(24).optional().describe('Cell padding in px (0–24).'),
    captionPosition: CaptionPositionSchema.optional()
      .describe('Where table captions sit: `above` (default) or `below`. A caption is a paragraph starting with `Table:` (or `:`) right before or after the table in the Markdown.'),
    captionLabel: z.boolean().optional()
      .describe('Prefix every table caption with "Table 1: " in the document language (default false).')
  }).optional(),
  blocks: z.object({
    imageRadius: z.number().min(0).max(32).optional().describe('Image corner radius in px (0–32).'),
    imageMaxWidth: z.number().min(10).max(100).optional().describe('Image max width as % of column (10–100).'),
    blockquoteStyle: BlockquoteStyleSchema.optional(),
    hrStyle: HrStyleSchema.optional()
      .describe('Horizontal-rule style. `rule`/`dashed`/`dotted` draw a line; `asterism` emits a centered ⁂ glyph (literary scene break); `none` is invisible.'),
    hrThickness: z.number().int().min(1).max(6).optional()
      .describe('HR stroke width in px (1–6). Ignored by asterism + none.'),
    figureLabel: z.boolean().optional()
      .describe('Prefix every figure (image) caption with "Figure 1: " in the document language (default false).'),
    referenceStyle: ReferenceStyleSchema.optional()
      .describe('Look of the reference list — the section headed References / Bibliography / Literatur / Références … : `plain` (default), `hanging` (hanging indent, APA / author-year), `brackets` (numbered lists labelled [1], [2] — IEEE).'),
    captionNumbering: CaptionNumberingSchema.optional()
      .describe('Figure / table numbers: `document` (default) 1, 2, 3; `chapter` 3.1, 3.2 within each top-level section (theses, books). Needs tables.captionLabel / blocks.figureLabel.'),
    captionLabelStyle: CaptionLabelStyleSchema.optional()
      .describe('`inline` (default) "Table 1: Title"; `stacked` a bold "Table 1" on its own line, the title under it (APA).')
  }).optional(),
  mermaid: z.object({
    theme: MermaidThemeSchema.optional()
      .describe('Diagram colours. `document` (recommended) derives every colour from the theme (brand, heading, text, secondary, paper), incl. chart palettes; the others are Mermaid built-ins. Diagrams always use the body font.')
  }).optional(),
  alerts: z.object({
    note: HexColorSchema.optional().describe('Color for [!NOTE] admonitions.'),
    tip: HexColorSchema.optional().describe('Color for [!TIP] admonitions.'),
    important: HexColorSchema.optional().describe('Color for [!IMPORTANT] admonitions.'),
    warning: HexColorSchema.optional().describe('Color for [!WARNING] admonitions.'),
    caution: HexColorSchema.optional().describe('Color for [!CAUTION] admonitions.')
  }).optional()
    .describe('GitHub-style admonition palette. Each color drives both the left border and the bg tint. Pick desaturated tones for warm-paper themes, traditional saturated hues for SaaS-doc themes. Caution is "stop, look here" — can borrow brand red since cover/print contexts have no AI seal to confuse.'),
  toc: z.object({
    maxDepth: z.enum(['2', '3', '4']).optional().describe('Max heading depth shown in TOC; pass as string numeric like "3".'),
    showTitle: z.boolean().optional(),
    showPageNumbers: z.boolean().optional(),
    leaderStyle: TocLeaderStyleSchema.optional()
  }).optional(),
  cover: z.object({
    enabled: z.boolean().optional()
      .describe('Toggle the title-sheet cover page (page 1 with title/subtitle/authors/date, no header/footer running text).'),
    layout: CoverLayoutSchema.optional()
      .describe('Cover composition: `editorial` (logo top, title at the upper third, meta lower third), `classic` (everything centred), `banner` (title in a brand-tinted top band), `minimal` (title only), `title-block` (NO cover page — papers: title, subtitle, authors with affiliations, date and the abstract at the top of page 1, text follows on the same page; the abstract is the document\'s own leading "## Abstract" section, which moves into the block).'),
    showTitle: z.boolean().optional(),
    showSubtitle: z.boolean().optional(),
    subtitle: z.string().max(200).optional().describe('Cover subtitle text (≤200 chars).'),
    showDate: z.boolean().optional(),
    date: z.string().regex(/^$|^\d{4}-\d{2}-\d{2}$/).optional()
      .describe('Publication date YYYY-MM-DD shown on the cover and by the {date} header/footer token (written out in the document language). Empty string = today.'),
    dateFormat: DateFormatSchema.optional()
      .describe('How the date is written: `locale` (default) the document language\'s long date, `us` "November 2, 2026" (APA), `iso` 2026-11-02.'),
    repeatTitle: z.boolean().optional()
      .describe('Repeat the title, bold and centred, at the top of the first text page after a title page (APA). Default false.'),
    showAuthors: z.boolean().optional(),
    authors: z.array(z.string().max(100)).max(10).optional()
      .describe('Author name list (up to 10). Each renders on its own line — for collaboration. Pass full name strings; ordering is preserved.'),
    affiliations: z.array(z.string().max(300)).max(10).optional()
      .describe('Affiliation per author, same order as `authors` (department, institution, address, e-mail — separate lines with \\n). Shown under each author on every cover layout.'),
    rules: z.boolean().optional().describe('`title-block`: heavy rules above and below the title (arXiv look).'),
    smallCaps: z.boolean().optional().describe('Title and subtitle in small capitals.'),
    titleWeight: FontWeightSchema.optional()
      .describe('Weight of the cover / title-block title, 100–900 in steps of 100 (all layouts). Omit to follow headings.weight. arXiv: 400.'),
    titleSize: z.number().min(0.6).max(4).optional().describe('Cover / title-block title size as a multiple of the body size (0.6–4). 2.4 for cover pages, ~1.7 for a paper title block.'),
    subtitleSize: z.number().min(0.5).max(2.5).optional().describe('Subtitle size as a multiple of the body size (0.5–2.5).'),
    showLogo: z.boolean().optional()
      .describe('Render `brand.logoUrl` above the title block on the cover. Requires brand.logoUrl to be set.')
  }).optional(),
  brand: z.object({
    logoUrl: z.string().max(500).optional()
      .describe('Logo image URL: must be an image uploaded to THIS document (`/api/files/<this doc id>/<file id>`, png/jpg/gif/webp, e.g. one you generated or that is already in the document). External URLs are not accepted. Empty string clears the logo.'),
    logoHeight: z.number().int().min(8).max(80).optional()
      .describe('Logo height in px (8–80). Width scales proportionally.')
  }).optional(),
  customCss: z.string().max(CUSTOM_CSS_MAX_BYTES).optional()
    .describe(`Custom CSS for the document (preview, print and PDF only — never the app UI), appended after the generated theme CSS so its rules win. LAST RESORT: first use the structured fields above (fonts, sizes, colours, spacing, tables.zebra, blocks.*, alerts.*, header/footer, cover, layout.columns); write CSS only for what no field expresses (a coloured h2 underline, a custom alert look, a two-column section, page-number formats). REPLACES the whole existing custom CSS: call get_theme first and send the full text with your rules added — keep the user's existing rules. Empty string clears it. ${CUSTOM_CSS_AI_REFERENCE}`)
}).describe('Update document theme settings. Pass ONLY the fields you want to change — omitted fields keep their current value. The change broadcasts live to all collaborators and persists to the database. NEW theme surfaces shipped recently: chapter labels + numbering depth (`headings.chapterLabel/chapterWord/numberingDepth`, `headings.numbering: "decimal-zero"`), `{section}` with its number / the section a page starts in (`header.sectionNumber/sectionMode`), the `{author}` token, chapter-relative and stacked captions (`blocks.captionNumbering/captionLabelStyle`), a repeated title and date formats (`cover.repeatTitle/dateFormat`), mirrored book margins (`page.mirrorMargins`), a drop cap on every chapter (`body.dropCap: "every-chapter"`), numbering styles (`headings.numbering: "decimal-dot" | "ieee"`), centred heading levels (`headings.levels.hN.align`), per-side page margins (`page.marginTop/Right/Bottom/Left`), table captions (`tables.captionPosition/captionLabel`), figure numbers (`blocks.figureLabel`), reference-list style (`blocks.referenceStyle`), the `{section}` header/footer token, header/footer rule (`header.rule`, `footer.rule`), per-level heading look (`headings.levels`), cover title weight (`cover.titleWeight`), `{.unnumbered}` headings, the `arxiv` preset, section numbering (`headings.numbering`), code block look (`code.font/background/frame/wrap/lineNumbers`), paper title block (`cover.layout: "title-block"` + `cover.affiliations`), A5 pages, bundled TeX fonts (TeX Gyre Termes / Heros, Latin Modern Roman / Mono), cover-page section, multi-author list, drop cap (`body.dropCap`), asterism HR (`blocks.hrStyle: "asterism"`), eyebrow font (`meta.font`), secondary color (`color.secondary`), per-kind alert palette (`alerts.*`), custom CSS (`customCss` — read the field docs before using it).')

export type UpdateThemeInput = z.infer<typeof UpdateThemeArgs>
