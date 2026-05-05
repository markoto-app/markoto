import { upsertOAuthUser } from '../../repos/users'
import { SESSION_VERSION } from '../../utils/validatedSession'
import { bootstrapAdminFromEnv } from '../../utils/adminBootstrap'

export default defineOAuthGoogleEventHandler({
  config: { scope: ['openid', 'email', 'profile'] },
  async onSuccess(event, { user }) {
    // Google's OIDC userinfo carries `email_verified: boolean`
    // directly. Pipe it through unchanged — the merge path only
    // acts on it when it's strictly true.
    const googleUser = user as { sub: string, name: string, email: string | null, email_verified?: boolean, picture: string }
    const emailVerified = googleUser.email_verified === true

    const { userId, outcome } = await upsertOAuthUser({
      provider: 'google',
      providerUserId: googleUser.sub,
      name: googleUser.name,
      email: googleUser.email,
      avatarUrl: googleUser.picture,
      emailVerified
    })

    // One-shot env-allowlist admin bootstrap. Idempotent (no-ops
    // if the user is already admin OR not on the allowlist).
    await bootstrapAdminFromEnv({ userId, email: googleUser.email ?? null })

    await setUserSession(event, {
      user: {
        id: userId,
        name: googleUser.name,
        email: googleUser.email,
        avatar: googleUser.picture,
        provider: 'google'
      },
      loggedInAt: Date.now(),
      v: SESSION_VERSION
    })
    const target = outcome === 'merged' ? '/?linked=google' : '/'
    return sendRedirect(event, target)
  }
})
