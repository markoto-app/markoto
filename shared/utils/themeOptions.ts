import type { CodeBackground, CodeFrame, DocTheme, HeadingNumbering } from '../types/theme'

/**
 * Defaults for the OPTIONAL theme fields (added after themes were already
 * stored, so a stored theme may lack them). The schema keeps them
 * optional — a stored theme without them stays valid, no data migration —
 * and every reader resolves them here: `themeToCss`, the theme panel, the
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

/**
 * Fill every optional field with its default — for UIs that bind each
 * field (theme panel) and for showing a theme in full (`get_theme`).
 * Returns a new object; `theme` is not changed.
 */
export function withThemeDefaults(theme: DocTheme): DocTheme {
  const code = resolveCodeOptions(theme)
  const tb = resolveTitleBlock(theme)
  return {
    ...theme,
    headings: { ...theme.headings, numbering: headingNumbering(theme) },
    code: {
      ...theme.code,
      ...(code.font ? { font: code.font } : {}),
      background: code.background,
      frame: code.frame,
      wrap: code.wrap,
      lineNumbers: code.lineNumbers
    },
    cover: { ...theme.cover, affiliations: tb.affiliations, rules: tb.rules, smallCaps: tb.smallCaps }
  }
}
