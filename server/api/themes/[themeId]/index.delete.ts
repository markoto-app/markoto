import { deleteTheme, getThemeById } from '../../../repos/themes'
import { themeParams } from '~~/shared/api/brand'

// Deletes a saved theme preset. The `(themeId, userId)` repo guard returns 404
// (not 403) for another user's id so foreign rows don't leak.
//
// Documents created with this theme keep their copy (`documents.theme` is a
// snapshot, not a reference), and `workspaces.default_theme` is not cleared;
// admins do that in the workspace settings.

export default defineApiHandler({
  access: allow.user(),
  params: themeParams,
  handler: async ({ self, params: { themeId } }) => {
    const existing = await getThemeById(self, themeId)
    if (!existing) throw apiError('resource/not-found')

    await deleteTheme(self, themeId)
    return { ok: true }
  }
})
