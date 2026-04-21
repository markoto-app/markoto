import { upsertOAuthUser } from '../../repos/users'
import { SESSION_VERSION } from '../../utils/validatedSession'

export default defineOAuthGitHubEventHandler({
  config: { emailRequired: true },
  async onSuccess(event, { user }) {
    const userId = await upsertOAuthUser({
      provider: 'github',
      providerUserId: user.id.toString(),
      login: user.login,
      name: user.name || user.login,
      email: user.email,
      avatarUrl: user.avatar_url
    })

    await setUserSession(event, {
      user: {
        id: userId,
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
