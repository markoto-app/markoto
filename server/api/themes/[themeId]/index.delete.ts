import { deleteTheme, getThemeById } from '../../../repos/themes'

// Deletes a saved theme preset. The `(themeId, userId)` repo guard returns 404
// (not 403) for another user's id so foreign rows don't leak.
//
// Documents created with this theme keep their copy (`documents.theme` is a
// snapshot, not a reference), and `workspaces.default_theme` is not cleared;
// admins do that in the workspace settings.

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  const themeId = getRouterParam(event, 'themeId')
  if (!themeId) throw createError({ statusCode: 400, message: 'themeId required' })

  const existing = await getThemeById(themeId, userId)
  if (!existing) throw createError({ statusCode: 404, message: 'Theme not found' })

  await deleteTheme(themeId, userId)
  return { ok: true }
})
