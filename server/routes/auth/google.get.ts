import { eq } from 'drizzle-orm'
import { users } from '../../db/schema'
import { SESSION_VERSION } from '../../utils/validatedSession'

export default defineOAuthGoogleEventHandler({
  config: { scope: ['openid', 'email', 'profile'] },
  async onSuccess(event, { user }) {
    const db = useDatabase()

    const existing = (await db.select().from(users).where(eq(users.googleId, user.sub)).limit(1))[0]
    if (existing) {
      await db.update(users).set({
        name: user.name,
        email: user.email,
        avatarUrl: user.picture
      }).where(eq(users.googleId, user.sub))
    } else {
      await db.insert(users).values({
        googleId: user.sub,
        name: user.name,
        email: user.email,
        avatarUrl: user.picture
      })
    }

    const dbUser = (await db.select({ id: users.id }).from(users).where(eq(users.googleId, user.sub)).limit(1))[0]!

    await setUserSession(event, {
      user: {
        id: dbUser.id,
        name: user.name,
        email: user.email,
        avatar: user.picture,
        provider: 'google'
      },
      loggedInAt: Date.now(),
      v: SESSION_VERSION
    })
    return sendRedirect(event, '/')
  }
})
