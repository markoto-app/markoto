import { eq } from 'drizzle-orm'
import { users } from '../../db/schema'

export default defineOAuthGitHubEventHandler({
  config: { emailRequired: true },
  async onSuccess(event, { user }) {
    const db = useDatabase()

    // Upsert user
    const existing = db.select().from(users).where(eq(users.githubId, user.id.toString())).get()
    if (existing) {
      db.update(users).set({
        login: user.login,
        name: user.name || user.login,
        email: user.email,
        avatarUrl: user.avatar_url
      }).where(eq(users.githubId, user.id.toString())).run()
    } else {
      db.insert(users).values({
        githubId: user.id.toString(),
        login: user.login,
        name: user.name || user.login,
        email: user.email,
        avatarUrl: user.avatar_url
      }).run()
    }

    const dbUser = db.select({ id: users.id }).from(users).where(eq(users.githubId, user.id.toString())).get()!

    await setUserSession(event, {
      user: {
        id: dbUser.id,
        login: user.login,
        name: user.name || user.login,
        email: user.email,
        avatar: user.avatar_url,
        provider: 'github'
      },
      loggedInAt: Date.now()
    })
    return sendRedirect(event, '/')
  }
})
