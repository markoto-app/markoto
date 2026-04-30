import { listThemesByUser } from '../../repos/themes'

// List the caller's saved themes. The `(updatedAt desc)` ordering puts
// the most recently saved/edited preset first — same reading direction
// as the Recent Documents list on the homepage.

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const rows = await listThemesByUser(session.user.id)
  return {
    themes: rows.map(r => ({
      themeId: r.themeId,
      name: r.name,
      theme: r.theme,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt
    }))
  }
})
