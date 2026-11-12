import { nanoid } from 'nanoid'
import { createSavedThemeBody } from '~~/shared/api/brand'
import { countThemesByUser, createTheme } from '../../repos/themes'
import { readSavedThemeDescription, readSavedThemeName } from '../../utils/rendering/savedThemeFields'
import { assertPlanLimit, resolveUserPlan } from '../../utils/billing/entitlements'

// Saves a theme as a personal preset. Body: `{ name, description?, theme }`.
// Per-user cap is the plan's `savedThemes` (shared/config/tiers.ts). Validation
// reuses `DocThemeSchema`, which also gates `documents.theme` writes. Name /
// description limits: shared/config/savedThemes.ts.

export default defineApiHandler({
  access: allow.user(),
  body: createSavedThemeBody,
  handler: async ({ event, user, self, body }) => {
    const userId = user.id
    const name = readSavedThemeName(body.name ?? '')
    const description = readSavedThemeDescription(body.description)

    // No document context: any doc's upload path passes; the render-time
    // sanitizer drops the ones that don't belong to the doc it's applied to.
    assertValidThemeCustomCss(body.theme, null, event)

    const owned = await countThemesByUser(self)
    assertPlanLimit(
      await resolveUserPlan(userId),
      'savedThemes',
      owned,
      'You\'ve reached the saved-theme limit of your plan. Delete one to save a new theme.'
    )

    const themeId = nanoid(10)
    const row = await createTheme(self, {
      themeId,
      name,
      description,
      theme: body.theme
    })

    return {
      themeId: row.themeId,
      name: row.name,
      description: row.description,
      theme: row.theme,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
  }
})
