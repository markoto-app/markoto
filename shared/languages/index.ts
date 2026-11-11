/**
 * Document language handling. Either an ISO 639-1 code from the curated
 * preset list OR any user-typed string ("english", "Deutsch",
 * "Romantsch", "Schwiizerdütsch"). The AI consumes whatever string we
 * pass and renders output in that language — no need to validate
 * against a closed set.
 *
 * The presets seed the dropdown in the new-doc dialog and the editor's
 * Document tab; the free-text input below them is the escape hatch.
 *
 * Cap: 50 chars. Long enough for "Schwiizerdütsch" + a region tag,
 * short enough to bound prompt-token cost and keep storage sane.
 */

export const LANGUAGE_PRESETS = ['en', 'de', 'fr', 'es', 'ja', 'zh'] as const

export const LANGUAGE_MAX_LENGTH = 50

/**
 * Resolve a stored language string into a human display name suitable
 * for the AI prompt and the UI badge.
 *
 * For ISO codes (`en`, `de-CH`), `Intl.DisplayNames` with the SAME
 * locale as the display target gives the language as IT NAMES ITSELF
 * — `de` → "Deutsch", not "German". The AI sees "Write all prose in
 * Deutsch" which produces measurably better adherence than the English
 * exonym.
 *
 * For free-text values that aren't BCP-47 (`english`, `Romantsch`),
 * `Intl.DisplayNames` returns the input unchanged or undefined. We
 * fall back to the raw string — the AI handles arbitrary language
 * names natively.
 */
export function resolveLanguageDisplayName(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) return 'English'

  // Try BCP-47 resolution first. Many free-text inputs (`english`,
  // `Deutsch`) won't satisfy `Intl.DisplayNames` parsing rules and
  // will throw or return undefined; the catch + nullish path falls
  // back to the literal string for those.
  try {
    const display = new Intl.DisplayNames([trimmed], { type: 'language', fallback: 'none' })
    const resolved = display.of(trimmed)
    if (resolved && resolved.length > 0) return resolved
  } catch {
    // Intl.DisplayNames throws RangeError on malformed BCP-47 tags
    // (e.g. inputs containing spaces). Fall through to the literal.
  }
  return trimmed
}

/**
 * Two-character badge for the workspace overview. ISO codes uppercase
 * to two letters (`en` → `EN`); free-text strings take the first 4
 * letters uppercased (`Schwiizerdütsch` → `SCHW`). Pure presentation —
 * the source-of-truth value remains whatever the user stored.
 */
export function languageBadge(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) return 'EN'
  // BCP-47 codes are 2-3 letters with optional `-XX` region. Match
  // the language part only.
  const isoMatch = /^([a-z]{2,3})(-[A-Z]{2})?$/.exec(trimmed)
  if (isoMatch) return isoMatch[1]!.toUpperCase()
  return trimmed.slice(0, 4).toUpperCase()
}

export function isValidLanguage(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= LANGUAGE_MAX_LENGTH
}
