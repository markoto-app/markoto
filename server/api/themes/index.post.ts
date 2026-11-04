import { nanoid } from 'nanoid'
import { DocThemeSchema } from '~~/shared/types/theme'
import { SAVED_THEMES_PER_USER_MAX } from '~~/shared/config/savedThemes'
import { countThemesByUser, createTheme } from '../../repos/themes'
import { readSavedThemeDescription, readSavedThemeName } from '../../utils/savedThemeFields'

// Save a theme as a personal preset. Body: `{ name: string, description?: string, theme: DocTheme }`.
// Per-user cap is 20 (parity with the workspaces-owned cap on Free/Pro/Max).
// Validation reuses `DocThemeSchema` — the same Zod schema that gates
// `documents.theme` writes — so any theme that's valid in a doc is
// valid as a preset. Name / description limits: shared/config/savedThemes.ts.

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  const body = await readBody<{ name?: unknown, description?: unknown, theme?: unknown }>(event)

  const name = readSavedThemeName(body?.name ?? '')
  const description = readSavedThemeDescription(body?.description)

  const parsed = DocThemeSchema.safeParse(body?.theme)
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: 'Invalid theme payload',
      data: { issues: parsed.error.issues }
    })
  }

  // No document context: any doc's upload path passes; the render-time
  // sanitizer drops the ones that don't belong to the doc it's applied to.
  assertValidThemeCustomCss(parsed.data, null, event)

  const owned = await countThemesByUser(userId)
  if (owned >= SAVED_THEMES_PER_USER_MAX) {
    throw createError({
      statusCode: 409,
      message: `You've reached the saved-theme limit (${SAVED_THEMES_PER_USER_MAX}). Delete one to save a new theme.`,
      data: { cap: SAVED_THEMES_PER_USER_MAX }
    })
  }

  const themeId = nanoid(10)
  const row = await createTheme({
    themeId,
    userId,
    name,
    description,
    theme: parsed.data
  })

  return {
    themeId: row.themeId,
    name: row.name,
    description: row.description,
    theme: row.theme,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
})
