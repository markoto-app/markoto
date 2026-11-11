import { listThemesByUser } from '../../repos/themes'

// Lists the caller's saved themes, most recently saved/edited first.

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const rows = await listThemesByUser(session.user.id)
  return {
    themes: rows.map(r => ({
      themeId: r.themeId,
      name: r.name,
      description: r.description,
      theme: r.theme,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt
    }))
  }
})
