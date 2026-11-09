/**
 * Limits for user-saved theme presets (`themes` table). Shared by the
 * REST endpoints (`server/api/themes/*`), the AI `save_theme_as_preset`
 * tool and the save / edit dialog (`SavedThemeDialog.vue`), so the
 * client's character counters match what the server accepts.
 */
export const SAVED_THEME_NAME_MAX = 80
export const SAVED_THEME_DESCRIPTION_MAX = 200
// How many presets a user may save is a plan limit: `savedThemes` in
// shared/config/tiers.ts.

export type SavedThemeTextIssue = 'required' | 'too-long' | 'not-a-string'

/**
 * Trim and check a saved theme's name. Returns the trimmed name or the
 * problem. Counted in UTF-16 code units like `String#length` (and like
 * the `maxlength` attribute the dialog uses).
 */
export function checkSavedThemeName(raw: unknown): { ok: true, value: string } | { ok: false, issue: SavedThemeTextIssue } {
  if (typeof raw !== 'string') return { ok: false, issue: 'not-a-string' }
  const value = raw.trim()
  if (!value) return { ok: false, issue: 'required' }
  if (value.length > SAVED_THEME_NAME_MAX) return { ok: false, issue: 'too-long' }
  return { ok: true, value }
}

/** Trim and check the optional description ('' = none). */
export function checkSavedThemeDescription(raw: unknown): { ok: true, value: string } | { ok: false, issue: SavedThemeTextIssue } {
  if (raw === undefined || raw === null) return { ok: true, value: '' }
  if (typeof raw !== 'string') return { ok: false, issue: 'not-a-string' }
  const value = raw.trim()
  if (value.length > SAVED_THEME_DESCRIPTION_MAX) return { ok: false, issue: 'too-long' }
  return { ok: true, value }
}
