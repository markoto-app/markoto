import type { CaptionLabelStyle, CaptionNumbering, CaptionPosition, CodeBackground, CodeFrame, DateFormat, DocTheme, HeadingAlign, HeadingLevelKey, HeadingNumbering, HeadingStyle, NumberingDepth, ReferenceStyle, RunningSlots, SectionMode } from '../../types/theme'

/**
 * Defaults for the OPTIONAL theme fields. A stored theme may lack them,
 * so the schema keeps them optional (no data migration) and every reader resolves them here: `themeToCss`, the theme panel, the
 * AI/MCP `get_theme`. Built-in presets and `defaultTheme` spell every
 * field out.
 */
export interface ResolvedCodeOptions {
  /** Code font family, or null for the system monospace stack. */
  font: string | null
  background: CodeBackground
  frame: CodeFrame
  wrap: boolean
  lineNumbers: boolean
}

export const CODE_OPTION_DEFAULTS: Omit<ResolvedCodeOptions, 'font'> = {
  background: 'auto',
  frame: 'none',
  wrap: true,
  lineNumbers: false
}

export function resolveCodeOptions(theme: DocTheme): ResolvedCodeOptions {
  const c = theme.code
  return {
    font: c.font ?? null,
    background: c.background ?? CODE_OPTION_DEFAULTS.background,
    frame: c.frame ?? CODE_OPTION_DEFAULTS.frame,
    wrap: c.wrap ?? CODE_OPTION_DEFAULTS.wrap,
    lineNumbers: c.lineNumbers ?? CODE_OPTION_DEFAULTS.lineNumbers
  }
}

export function headingNumbering(theme: DocTheme): HeadingNumbering {
  return theme.headings.numbering ?? 'none'
}

/** `headings.numberingDepth`: absent = 4 (every level h1–h4 that is numbered at all). */
export function numberingDepth(theme: DocTheme): NumberingDepth {
  return theme.headings.numberingDepth ?? 4
}

export interface ResolvedChapterLabel {
  /** "Chapter N" over numbered top-level headings (needs numbering on). */
  enabled: boolean
  /** The author's chapter word, or '' = the document language's. */
  word: string
}

/** `headings.chapterLabel` / `headings.chapterWord`: absent = off / ''. */
export function resolveChapterLabel(theme: DocTheme): ResolvedChapterLabel {
  return { enabled: theme.headings.chapterLabel ?? false, word: theme.headings.chapterWord ?? '' }
}

export interface ResolvedSectionToken {
  /** `{section}` shows "3 Procedures" instead of "Procedures". */
  number: boolean
  mode: SectionMode
}

/** `header.sectionNumber` / `header.sectionMode`: absent = title only / `first` (the look before the fields). */
export function resolveSectionToken(theme: DocTheme): ResolvedSectionToken {
  return { number: theme.header.sectionNumber ?? false, mode: theme.header.sectionMode ?? 'first' }
}

/** `cover.dateFormat`: absent = `locale`. */
export function coverDateFormat(theme: Pick<DocTheme, 'cover'>): DateFormat {
  return theme.cover.dateFormat ?? 'locale'
}

/** `cover.repeatTitle`: absent = off. */
export function repeatTitle(theme: DocTheme): boolean {
  return theme.cover.repeatTitle ?? false
}

/** `page.mirrorMargins`: absent = off. */
export function mirrorMargins(theme: DocTheme): boolean {
  return theme.page.mirrorMargins ?? false
}

export interface ResolvedTitleBlock {
  affiliations: string[]
  rules: boolean
  smallCaps: boolean
}

export function resolveTitleBlock(theme: DocTheme): ResolvedTitleBlock {
  return {
    affiliations: theme.cover.affiliations ?? [],
    rules: theme.cover.rules ?? false,
    smallCaps: theme.cover.smallCaps ?? false
  }
}

/** `header.rule` / `footer.rule`: absent = no rule. */
export function runningRule(slots: RunningSlots): boolean {
  return slots.rule ?? false
}

/**
 * Cover / title-block title weight. Absent = `headings.weight`: the title
 * follows the headings until the author picks a weight of its own. That
 * is an inheritance, not a fixed default, so `withThemeDefaults` leaves
 * the field absent and presets only set it where it differs (arXiv).
 */
export function coverTitleWeight(theme: DocTheme): number {
  return theme.cover.titleWeight ?? theme.headings.weight
}

export interface ResolvedHeadingLevel {
  /** Size as a multiple of the body size, or null = the modular scale. */
  size: number | null
  weight: number
  style: HeadingStyle
  smallCaps: boolean
  align: HeadingAlign
}

/** Look of heading level 1–6: `headings.levels.hN` (h1–h4) over the theme-wide values. */
export function resolveHeadingLevel(theme: DocTheme, level: number): ResolvedHeadingLevel {
  const key = `h${level}`
  const entry = isLevelKey(key) ? theme.headings.levels?.[key] : undefined
  return {
    size: entry?.size ?? null,
    weight: entry?.weight ?? theme.headings.weight,
    style: entry?.style ?? 'normal',
    smallCaps: entry?.smallCaps ?? false,
    align: entry?.align ?? 'left'
  }
}

export interface ResolvedPageMargins {
  top: number
  right: number
  bottom: number
  left: number
}

/** Page margins in mm: `page.marginTop/Right/Bottom/Left`, each falling back to `page.margin`. */
export function resolvePageMargins(theme: DocTheme): ResolvedPageMargins {
  const p = theme.page
  return {
    top: p.marginTop ?? p.margin,
    right: p.marginRight ?? p.margin,
    bottom: p.marginBottom ?? p.margin,
    left: p.marginLeft ?? p.margin
  }
}

export interface ResolvedCaptions {
  tablePosition: CaptionPosition
  tableLabel: boolean
  figureLabel: boolean
  numbering: CaptionNumbering
  labelStyle: CaptionLabelStyle
}

const CAPTION_DEFAULTS: ResolvedCaptions = {
  tablePosition: 'above',
  tableLabel: false,
  figureLabel: false,
  numbering: 'document',
  labelStyle: 'inline'
}

/** Table / figure caption options (`tables.captionPosition`, `tables.captionLabel`, `blocks.figureLabel`, `blocks.captionNumbering`, `blocks.captionLabelStyle`). */
export function resolveCaptions(theme: DocTheme): ResolvedCaptions {
  return {
    tablePosition: theme.tables.captionPosition ?? CAPTION_DEFAULTS.tablePosition,
    tableLabel: theme.tables.captionLabel ?? CAPTION_DEFAULTS.tableLabel,
    figureLabel: theme.blocks.figureLabel ?? CAPTION_DEFAULTS.figureLabel,
    numbering: theme.blocks.captionNumbering ?? CAPTION_DEFAULTS.numbering,
    labelStyle: theme.blocks.captionLabelStyle ?? CAPTION_DEFAULTS.labelStyle
  }
}

/** `blocks.referenceStyle`: absent = `plain`. */
export function referenceStyle(theme: DocTheme): ReferenceStyle {
  return theme.blocks.referenceStyle ?? 'plain'
}

function isLevelKey(key: string): key is HeadingLevelKey {
  return key === 'h1' || key === 'h2' || key === 'h3' || key === 'h4'
}

/**
 * Fill every optional field with its default (except the inheriting ones:
 * `cover.titleWeight` follows `headings.weight` and `page.marginTop/Right/
 * Bottom/Left` follow `page.margin` while absent), for UIs that bind each
 * field (theme panel) and for showing a theme in full (`get_theme`).
 * Returns a new object; `theme` is not changed.
 */
export function withThemeDefaults(theme: DocTheme): DocTheme {
  const code = resolveCodeOptions(theme)
  const tb = resolveTitleBlock(theme)
  const captions = resolveCaptions(theme)
  const chapter = resolveChapterLabel(theme)
  const section = resolveSectionToken(theme)
  return {
    ...theme,
    page: { ...theme.page, mirrorMargins: mirrorMargins(theme) },
    tables: { ...theme.tables, captionPosition: captions.tablePosition, captionLabel: captions.tableLabel },
    blocks: { ...theme.blocks, figureLabel: captions.figureLabel, referenceStyle: referenceStyle(theme), captionNumbering: captions.numbering, captionLabelStyle: captions.labelStyle },
    headings: { ...theme.headings, numbering: headingNumbering(theme), levels: theme.headings.levels ?? {}, numberingDepth: numberingDepth(theme), chapterLabel: chapter.enabled, chapterWord: chapter.word },
    header: { ...theme.header, rule: runningRule(theme.header), sectionNumber: section.number, sectionMode: section.mode },
    footer: { ...theme.footer, rule: runningRule(theme.footer) },
    code: {
      ...theme.code,
      ...(code.font ? { font: code.font } : {}),
      background: code.background,
      frame: code.frame,
      wrap: code.wrap,
      lineNumbers: code.lineNumbers
    },
    cover: { ...theme.cover, affiliations: tb.affiliations, rules: tb.rules, smallCaps: tb.smallCaps, dateFormat: coverDateFormat(theme), repeatTitle: repeatTitle(theme) }
  }
}
