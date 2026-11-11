import { nanoid } from 'nanoid'
import { DocThemeSchema } from '~~/shared/types/theme'
import { countThemesByUser, createTheme } from '../../repos/themes'
import { readSavedThemeDescription, readSavedThemeName } from '../../utils/rendering/savedThemeFields'
import { assertPlanLimit, resolveUserPlan } from '../../utils/billing/entitlements'

// Saves a theme as a personal preset. Body: `{ name, description?, theme }`.
// Per-user cap is the plan's `savedThemes` (shared/config/tiers.ts). Validation
// reuses `DocThemeSchema`, which also gates `documents.theme` writes. Name /
// description limits: shared/config/savedThemes.ts.

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
  assertPlanLimit(
    await resolveUserPlan(userId),
    'savedThemes',
    owned,
    'You\'ve reached the saved-theme limit of your plan. Delete one to save a new theme.'
  )

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
