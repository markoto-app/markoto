import { deleteTheme, getThemeById } from '../../../repos/themes'

// Delete a saved theme preset. The `(themeId, userId)` repo guard
// returns 404 (not 403) for another user's id so the endpoint doesn't
// leak existence of foreign rows.
//
// Note: documents that were CREATED with this theme keep their copy —
// `documents.theme` is a snapshot, not a foreign-key reference. Same
// goes for `workspaces.default_theme`: deleting the source preset does
// not clear a workspace's default. Admins who want to clear the
// workspace default do that explicitly via the workspace settings UI.

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
