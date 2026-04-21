import { upsertOAuthUser } from '../../repos/users'
import { SESSION_VERSION } from '../../utils/validatedSession'

export default defineOAuthGoogleEventHandler({
  config: { scope: ['openid', 'email', 'profile'] },
  async onSuccess(event, { user }) {
    const userId = await upsertOAuthUser({
      provider: 'google',
      providerUserId: user.sub,
      name: user.name,
      email: user.email,
      avatarUrl: user.picture
    })

    await setUserSession(event, {
      user: {
        id: userId,
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
