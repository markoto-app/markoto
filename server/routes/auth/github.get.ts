import { upsertOAuthUser } from '../../repos/users'
import { SESSION_VERSION } from '../../utils/validatedSession'
import { bootstrapAdminFromEnv } from '../../utils/adminBootstrap'

export default defineOAuthGitHubEventHandler({
  config: { emailRequired: true },
  async onSuccess(event, { user }) {
    // GitHub + `emailRequired: true` → userinfo returns the user's
    // PRIMARY verified email. GitHub never exposes a primary email
    // that hasn't been verified. So a non-null email on this
    // codepath is safe to treat as verified for merge purposes.
    const emailVerified = !!user.email

    const { userId, outcome } = await upsertOAuthUser({
      provider: 'github',
      providerUserId: user.id.toString(),
      login: user.login,
      name: user.name || user.login,
      email: user.email,
      avatarUrl: user.avatar_url,
      emailVerified
    })

    // One-shot env-allowlist admin bootstrap. Idempotent (no-ops
    // if the user is already admin OR not on the allowlist).
    await bootstrapAdminFromEnv({ userId, email: user.email ?? null })

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
    // `?linked=github` when we merged into an existing account; the
    // landing page reads this query param and surfaces a one-time
    // toast so the user understands what happened.
    const target = outcome === 'merged' ? '/?linked=github' : '/'
    return sendRedirect(event, target)
  }
})
