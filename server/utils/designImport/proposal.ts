import { DocThemeSchema, type DocTheme } from '~~/shared/types/theme'
import { formatCustomCssIssues, sanitizeCustomCss } from '~~/shared/utils/theme/customCss'
import { coerceThemePatch, mergeTheme } from '../ai/tools/themeMerge'
import { DESIGN_IMPORT_BASE_THEME } from './baseTheme'
import type { DesignThemePatch } from './prompt'

// A model proposal → a stored-quality DocTheme. Same gates as every other
// theme write: the patch's enums/ranges (Zod, at parse time), the full
// `DocThemeSchema`, and the custom-CSS sanitizer with no document
// context (a saved theme belongs to no document, the render path
// sanitizes again against the document it is applied to).

/** "Minimal custom CSS": anything longer is refused and the model told so. */
export const DESIGN_IMPORT_CSS_MAX_CHARS = 6000

export type AppliedProposal
  = | { ok: true, theme: DocTheme, notes: string[] }
    | { ok: false, error: string }

export function themeFromProposal(patch: DesignThemePatch, base: DocTheme = DESIGN_IMPORT_BASE_THEME): AppliedProposal {
  const notes: string[] = []
  const merged = mergeTheme(structuredClone(base), coerceThemePatch(patch))

  const css = merged.customCss?.trim() ?? ''
  if (css === '') {
    delete merged.customCss
  } else if (css.length > DESIGN_IMPORT_CSS_MAX_CHARS) {
    delete merged.customCss
    notes.push(`customCss was ${css.length} characters and was dropped; keep it under ${DESIGN_IMPORT_CSS_MAX_CHARS} and use theme fields instead.`)
  } else {
    const { issues } = sanitizeCustomCss(css, { docId: null })
    if (issues.length > 0) {
      delete merged.customCss
      notes.push(`customCss was dropped because of: ${formatCustomCssIssues(issues).replace(/\n/g, ' ')}`)
    } else {
      merged.customCss = css
    }
  }

  const parsed = DocThemeSchema.safeParse(merged)
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 8).map(i => `${i.path.join('.')}: ${i.message}`)
    return { ok: false, error: `The proposed theme is invalid, ${issues.join('; ')}` }
  }
  return { ok: true, theme: parsed.data, notes }
}
