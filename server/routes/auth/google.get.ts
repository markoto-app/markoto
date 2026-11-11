import { getSessionEpoch, upsertOAuthUser } from '../../repos/users'
import { SESSION_VERSION } from '../../utils/auth/validatedSession'
import { bootstrapAdminFromEnv } from '../../utils/auth/adminBootstrap'
import { googleVerifiedEmail } from '../../utils/auth/oauthEmail'

export default defineOAuthGoogleEventHandler({
  config: { scope: ['openid', 'email', 'profile'] },
  async onSuccess(event, { user }) {
    // Google's userinfo carries `email_verified: boolean`. Only a
    // verified address is used (stored, merged, matched against the
    // admin allowlist); an unverified one is stored as NULL, like OIDC.
    const googleUser = user as { sub: string, name: string, email: string | null, email_verified?: boolean }
    const email = googleVerifiedEmail(googleUser)

    const { userId, outcome } = await upsertOAuthUser({
      provider: 'google',
      providerUserId: googleUser.sub,
      name: googleUser.name,
      email,
      emailVerified: email !== null
    })

    // One-shot env-allowlist admin bootstrap (verified email only).
    // Idempotent (no-ops if the user is already admin OR not listed).
    await bootstrapAdminFromEnv({ userId, email })

    await setUserSession(event, {
      user: {
        id: userId,
        name: googleUser.name,
        email,
        provider: 'google'
      },
      loggedInAt: Date.now(),
      // Current session epoch; a later "log out everywhere" bumps it.
      e: await getSessionEpoch(userId),
      v: SESSION_VERSION
    })
    const target = outcome === 'merged' ? '/?linked=google' : '/'
    return sendRedirect(event, target)
  }
})
