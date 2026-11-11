import { listThemesByUser } from '../../repos/themes'

// Lists the caller's saved themes, most recently saved/edited first.

export default defineApiHandler({
  access: allow.user(),
  handler: async ({ user }) => {
    const rows = await listThemesByUser(user.id)
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
  }
})
