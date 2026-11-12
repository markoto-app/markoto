import type { DocTheme } from '~~/shared/types/theme'
import { themeParams, updateSavedThemeBody } from '~~/shared/api/brand'
import { getThemeById, updateTheme } from '../../../repos/themes'
import { readSavedThemeDescription, readSavedThemeName } from '../../../utils/rendering/savedThemeFields'

// Renames / describes / updates a saved theme. Body: `{ name?, description?,
// theme? }`, any subset. The `(themeId, userId)` tuple prevents changing
// another user's theme via a guessed id, and the 404 (not 403) hides whether a
// foreign id exists. Limits: shared/config/savedThemes.ts.

export default defineApiHandler({
  access: allow.user(),
  params: themeParams,
  body: updateSavedThemeBody,
  handler: async ({ event, self, params: { themeId }, body }) => {
    const existing = await getThemeById(self, themeId)
    if (!existing) throw apiError('resource/not-found')

    const update: { name?: string, description?: string, theme?: DocTheme } = {}

    if (body?.name !== undefined) update.name = readSavedThemeName(body.name)
    if (body?.description !== undefined) update.description = readSavedThemeDescription(body.description)

    if (body?.theme !== undefined) {
      assertValidThemeCustomCss(body.theme, null, event)
      update.theme = body.theme
    }

    if (Object.keys(update).length === 0) throw apiError('request/invalid', { field: 'body' })

    await updateTheme(self, themeId, update)
    return { ok: true }
  }
})
