import { getSessionEpoch, upsertOAuthUser } from '../../repos/users'
import { SESSION_VERSION } from '../../utils/auth/validatedSession'
import { bootstrapAdminFromEnv } from '../../utils/auth/adminBootstrap'
import { githubVerifiedEmail, type GitHubEmailEntry } from '../../utils/auth/oauthEmail'

export default defineOAuthGitHubEventHandler({
  config: { emailRequired: true },
  async onSuccess(event, { user, tokens }) {
    // Only a VERIFIED address is used (stored, merged, matched against
    // the admin allowlist). GitHub's public profile email carries no
    // verification flag, so it is checked against /user/emails (the
    // `user:email` scope is requested via `emailRequired`); an unverified
    // or unresolvable address is stored as NULL, like OIDC.
    const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : ''
    const email = await githubVerifiedEmail(user, () => $fetch<GitHubEmailEntry[]>('https://api.github.com/user/emails', {
      headers: {
        'User-Agent': 'markoto-oauth',
        'Authorization': `token ${accessToken}`
      }
    }))

    const { userId, outcome } = await upsertOAuthUser({
      provider: 'github',
      providerUserId: user.id.toString(),
      login: user.login,
      name: user.name || user.login,
      email,
      emailVerified: email !== null
    })

    // One-shot env-allowlist admin bootstrap (verified email only).
    // Idempotent (no-ops if the user is already admin OR not listed).
    await bootstrapAdminFromEnv({ userId, email })

    await setUserSession(event, {
      user: {
        id: userId,
        login: user.login,
        name: user.name || user.login,
        email,
        provider: 'github'
      },
      loggedInAt: Date.now(),
      // Current session epoch; a later "log out everywhere" bumps it.
      e: await getSessionEpoch(userId),
      v: SESSION_VERSION
    })
    // `?linked=github` when we merged into an existing account; the
    // landing page reads this query param and surfaces a one-time
    // toast so the user understands what happened.
    const target = outcome === 'merged' ? '/?linked=github' : '/'
    return sendRedirect(event, target)
  }
})
