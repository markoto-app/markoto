import { eq } from 'drizzle-orm'
import { users } from '../../db/schema'

export default defineOAuthGoogleEventHandler({
  config: { scope: ['openid', 'email', 'profile'] },
  async onSuccess(event, { user }) {
    const db = useDatabase()

    const existing = db.select().from(users).where(eq(users.googleId, user.sub)).get()
    if (existing) {
      db.update(users).set({
        name: user.name,
        email: user.email,
        avatarUrl: user.picture
      }).where(eq(users.googleId, user.sub)).run()
    } else {
      db.insert(users).values({
        googleId: user.sub,
        name: user.name,
        email: user.email,
        avatarUrl: user.picture
      }).run()
    }

    const dbUser = db.select({ id: users.id }).from(users).where(eq(users.googleId, user.sub)).get()!

    await setUserSession(event, {
      user: {
        id: dbUser.id,
        name: user.name,
        email: user.email,
        avatar: user.picture,
        provider: 'google'
      },
      loggedInAt: Date.now()
    })
    return sendRedirect(event, '/')
  }
})
