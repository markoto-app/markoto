import {
  SAVED_THEME_DESCRIPTION_MAX,
  SAVED_THEME_NAME_MAX,
  checkSavedThemeDescription,
  checkSavedThemeName
} from '~~/shared/config/savedThemes'

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
  const messages = {
    'required': 'Name is required',
    'too-long': `Name too long (max ${SAVED_THEME_NAME_MAX})`,
    'not-a-string': 'Name must be a string'
  } as const
  throw createError({ statusCode: 400, message: messages[name.issue], data: { code: `theme/name-${name.issue}` } })
}

export function readSavedThemeDescription(raw: unknown): string {
  const description = checkSavedThemeDescription(raw)
  if (description.ok) return description.value
  const message = description.issue === 'too-long'
    ? `Description too long (max ${SAVED_THEME_DESCRIPTION_MAX})`
    : 'Description must be a string'
  throw createError({ statusCode: 400, message, data: { code: `theme/description-${description.issue}` } })
}
