import { checkSavedThemeDescription, checkSavedThemeName } from '~~/shared/config/savedThemes'
import { apiError } from '../api/apiError'

/**
 * Request-body readers for the saved-theme endpoints (POST /api/themes,
 * PATCH /api/themes/:id): the shared checks from
 * `shared/config/savedThemes.ts`, turned into 400s with a stable
 * `data.code` (`theme/name-required|too-long|not-a-string`,
 * `theme/description-too-long|not-a-string`).
 */
export function readSavedThemeName(raw: unknown): string {
  const name = checkSavedThemeName(raw)
  if (name.ok) return name.value
  throw apiError(`theme/name-${name.issue}` as const)
}

export function readSavedThemeDescription(raw: unknown): string {
  const description = checkSavedThemeDescription(raw)
  if (description.ok) return description.value
  throw apiError(description.issue === 'too-long' ? 'theme/description-too-long' : 'theme/description-not-a-string')
}
