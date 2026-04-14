import { eq } from 'drizzle-orm'
import { users } from '../../db/schema'
import { SESSION_VERSION } from '../../utils/validatedSession'

export default defineOAuthGitHubEventHandler({
  config: { emailRequired: true },
  async onSuccess(event, { user }) {
    const db = useDatabase()

    // Upsert user
    const existing = (await db.select().from(users).where(eq(users.githubId, user.id.toString())).limit(1))[0]
    if (existing) {
      await db.update(users).set({
        login: user.login,
        name: user.name || user.login,
        email: user.email,
        avatarUrl: user.avatar_url
      }).where(eq(users.githubId, user.id.toString()))
    } else {
      await db.insert(users).values({
        githubId: user.id.toString(),
        login: user.login,
        name: user.name || user.login,
        email: user.email,
        avatarUrl: user.avatar_url
      })
    }

    const dbUser = (await db.select({ id: users.id }).from(users).where(eq(users.githubId, user.id.toString())).limit(1))[0]!

    await setUserSession(event, {
      user: {
        id: dbUser.id,
        login: user.login,
        name: user.name || user.login,
        email: user.email,
        avatar: user.avatar_url,
        provider: 'github'
      },
      loggedInAt: Date.now(),
      v: SESSION_VERSION
    })
    return sendRedirect(event, '/')
  }
})
