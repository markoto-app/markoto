import { nanoid } from 'nanoid'
import { DocThemeSchema } from '~~/shared/types/theme'
import { countThemesByUser, createTheme } from '../../repos/themes'

// Save a theme as a personal preset. Body: `{ name: string, theme: DocTheme }`.
// Per-user cap is 20 (parity with the workspaces-owned cap on Free/Pro/Max).
// Validation reuses `DocThemeSchema` — the same Zod schema that gates
// `documents.theme` writes — so any theme that's valid in a doc is
// valid as a preset.

const MAX_THEMES_PER_USER = 20
const MAX_NAME_LENGTH = 80

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  const body = await readBody<{ name?: unknown, theme?: unknown }>(event)

  const rawName = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!rawName) throw createError({ statusCode: 400, message: 'Name is required' })
  if (rawName.length > MAX_NAME_LENGTH) {
    throw createError({ statusCode: 400, message: `Name too long (max ${MAX_NAME_LENGTH})` })
  }

  const parsed = DocThemeSchema.safeParse(body?.theme)
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: 'Invalid theme payload',
      data: { issues: parsed.error.issues }
    })
  }

  const owned = await countThemesByUser(userId)
  if (owned >= MAX_THEMES_PER_USER) {
    throw createError({
      statusCode: 409,
      message: `You've reached the saved-theme limit (${MAX_THEMES_PER_USER}). Delete one to save a new theme.`,
      data: { cap: MAX_THEMES_PER_USER }
    })
  }

  const themeId = nanoid(10)
  const row = await createTheme({
    themeId,
    userId,
    name: rawName,
    theme: parsed.data
  })

  return {
    themeId: row.themeId,
    name: row.name,
    theme: row.theme,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
})
