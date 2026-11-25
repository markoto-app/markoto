import { getSessionEpoch } from '../../repos/users'
import { upsertOAuthUser } from '../../repos/userSignIn'
import { SESSION_VERSION } from '../../utils/auth/validatedSession'
import { bootstrapAdminFromEnv } from '../../utils/auth/adminBootstrap'
import { githubVerifiedEmail, type GitHubEmailEntry } from '../../utils/auth/oauthEmail'
import type { EventHandler } from 'h3'
import { captureOAuthSignup, rememberOAuthClick } from '../../utils/analytics/adConversions'
import { captureSignupSource, rememberOAuthSource, withSignupSource } from '../../utils/analytics/acquisitionSource'
import { loginLandingPath, rememberLoginReturn } from '../../utils/auth/loginReturn'

// The GitHub OAuth leg of nuxt-auth-utils: without `?code` it redirects to
// GitHub; with it, the module verifies `state` and exchanges the code
// before `onSuccess` runs.
const oauth: EventHandler = defineOAuthGitHubEventHandler({
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
    // A new account: Google Ads conversion (when the sign-in link carried a
    // click id) and `?signed_up=` for the client's cookieless sign-up event.
    // And the acquisition source the sign-in link carried (admin funnel).
    if (outcome === 'inserted') await captureOAuthSignup(event, userId)
    const signupSource = outcome === 'inserted' ? await captureSignupSource(event, userId) : null
    return sendRedirect(event, withSignupSource(await loginLandingPath(event, 'github', outcome), signupSource))
  }
})

export default defineApiHandler({
  access: allow.public('sign-in itself: the OAuth state check of nuxt-auth-utils guards the callback'),
  handler: async ({ event }): Promise<unknown> => {
    const result = await oauth(event)
    // Start leg (a redirect to the provider carrying `state`): park the
    // sign-in link's ad click id under that state. A no-op on the callback.
    await rememberOAuthClick(event)
    await rememberOAuthSource(event)
    // And the page the sign-in link asked to come back to.
    await rememberLoginReturn(event)
    return result
  }
})
