import { getSessionEpoch } from '../../repos/users'
import { upsertOAuthUser } from '../../repos/userSignIn'
import { SESSION_VERSION } from '../../utils/auth/validatedSession'
import { bootstrapAdminFromEnv } from '../../utils/auth/adminBootstrap'
import { googleVerifiedEmail } from '../../utils/auth/oauthEmail'
import type { EventHandler } from 'h3'
import { captureOAuthSignup, rememberOAuthClick } from '../../utils/analytics/adConversions'
import { captureSignupSource, rememberOAuthSource, withSignupSource } from '../../utils/analytics/acquisitionSource'
import { loginLandingPath, rememberLoginReturn } from '../../utils/auth/loginReturn'

// The Google OAuth leg of nuxt-auth-utils: without `?code` it redirects to
// Google; with it, the module verifies `state` and exchanges the code
// before `onSuccess` runs.
const oauth: EventHandler = defineOAuthGoogleEventHandler({
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
    // A new account: Google Ads conversion (when the sign-in link carried a
    // click id) and `?signed_up=` for the client's cookieless sign-up event.
    // And the acquisition source the sign-in link carried (admin funnel).
    if (outcome === 'inserted') await captureOAuthSignup(event, userId)
    const signupSource = outcome === 'inserted' ? await captureSignupSource(event, userId) : null
    return sendRedirect(event, withSignupSource(await loginLandingPath(event, 'google', outcome), signupSource))
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
