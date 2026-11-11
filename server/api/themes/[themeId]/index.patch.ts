import { DocThemeSchema, type DocTheme } from '~~/shared/types/theme'
import { getThemeById, updateTheme } from '../../../repos/themes'
import { readSavedThemeDescription, readSavedThemeName } from '../../../utils/rendering/savedThemeFields'

// Renames / describes / updates a saved theme. Body: `{ name?, description?,
// theme? }`, any subset. The `(themeId, userId)` tuple prevents changing
// another user's theme via a guessed id, and the 404 (not 403) hides whether a
// foreign id exists. Limits: shared/config/savedThemes.ts.

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  const themeId = getRouterParam(event, 'themeId')
  if (!themeId) throw createError({ statusCode: 400, message: 'themeId required' })

  const existing = await getThemeById(themeId, userId)
  if (!existing) throw createError({ statusCode: 404, message: 'Theme not found' })

  const body = await readBody<{ name?: unknown, description?: unknown, theme?: unknown }>(event)
  const update: { name?: string, description?: string, theme?: DocTheme } = {}

  if (body?.name !== undefined) update.name = readSavedThemeName(body.name)
  if (body?.description !== undefined) update.description = readSavedThemeDescription(body.description)

  if (body?.theme !== undefined) {
    const parsed = DocThemeSchema.safeParse(body.theme)
    if (!parsed.success) {
      throw createError({
        statusCode: 400,
        message: 'Invalid theme payload',
        data: { issues: parsed.error.issues }
      })
    }
    assertValidThemeCustomCss(parsed.data, null, event)
    update.theme = parsed.data
  }

  if (Object.keys(update).length === 0) {
    throw createError({ statusCode: 400, message: 'At least one of name, description or theme is required' })
  }

  await updateTheme(themeId, userId, update)
  return { ok: true }
})
