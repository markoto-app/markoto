import { DocThemeSchema } from '~~/shared/types/theme'
import { getThemeById, updateTheme } from '../../../repos/themes'

// Rename / update a saved theme. Body: `{ name?: string, theme?: DocTheme }`.
// Either or both fields may be supplied. The `(themeId, userId)` tuple
// in the repo prevents another user's theme from being renamed via a
// guessed id — a 404 is returned in that case rather than 403, so the
// endpoint doesn't leak whether a foreign id exists.

const MAX_NAME_LENGTH = 80

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  const themeId = getRouterParam(event, 'themeId')
  if (!themeId) throw createError({ statusCode: 400, message: 'themeId required' })

  const existing = await getThemeById(themeId, userId)
  if (!existing) throw createError({ statusCode: 404, message: 'Theme not found' })

  const body = await readBody<{ name?: unknown, theme?: unknown }>(event)
  const update: { name?: string, theme?: import('~~/shared/types/theme').DocTheme } = {}

  if (body?.name !== undefined) {
    if (typeof body.name !== 'string') {
      throw createError({ statusCode: 400, message: 'Name must be a string' })
    }
    const trimmed = body.name.trim()
    if (!trimmed) throw createError({ statusCode: 400, message: 'Name cannot be empty' })
    if (trimmed.length > MAX_NAME_LENGTH) {
      throw createError({ statusCode: 400, message: `Name too long (max ${MAX_NAME_LENGTH})` })
    }
    update.name = trimmed
  }

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
    throw createError({ statusCode: 400, message: 'At least one of name or theme is required' })
  }

  await updateTheme(themeId, userId, update)
  return { ok: true }
})
