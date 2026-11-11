import { getSessionEpoch, upsertOAuthUser } from '../../repos/users'
import { SESSION_VERSION } from '../../utils/auth/validatedSession'
import { bootstrapAdminFromEnv } from '../../utils/auth/adminBootstrap'
import { oidcRedirectUri, resolveOidcSettings, type OidcSettings } from '../../utils/oidc/settings'
import {
  buildOidcAuthorizationRequest,
  completeOidcAuthorization,
  getOidcConfiguration
} from '../../utils/oidc/client'
import {
  OIDC_FLOW_COOKIE,
  OIDC_FLOW_MAX_AGE_SECONDS,
  decodeFlowCookie,
  encodeFlowCookie
} from '../../utils/oidc/flowCookie'
import type { H3Event } from 'h3'

// Generic OpenID Connect sign-in for self-hosted identity providers.
// One route, two legs — like the nuxt-auth-utils handlers:
//
//   GET /auth/oidc                 → fresh state/nonce/PKCE, signed flow
//                                    cookie, 302 to the IdP
//   GET /auth/oidc?code=…&state=…  → (or ?error=…) validate + code exchange,
//                                    upsert by (issuer, sub), session, 302 /
//
// Protocol + validation live in `server/utils/oidc/client.ts`; the claim
// → profile mapping and the email rule in `server/utils/oidc/profile.ts`.

const isDevelopment = process.env.NODE_ENV === 'development'

// Configured URLs only — never the request Host header (boot validation
// refuses an OIDC setup with neither `_REDIRECT_URL` nor `NUXT_SITE_URL`).
function redirectUriFor(event: H3Event, settings: OidcSettings): string {
  const uri = oidcRedirectUri(settings, useRuntimeConfig(event).siteUrl)
  if (uri) return uri
  throw createError({
    statusCode: 503,
    message: 'OpenID Connect sign-in is not fully configured on this instance.',
    data: { code: 'auth/oidc-misconfigured' }
  })
}

function loginFailed(): Error {
  return createError({
    statusCode: 401,
    message: 'Sign-in with the identity provider failed. Please try again.',
    data: { code: 'auth/oidc-failed' }
  })
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = 'code' in err && typeof err.code === 'string' ? ` [${err.code}]` : ''
    return `${err.name}${code}: ${err.message}`
  }
  return 'unknown error'
}

export default defineEventHandler(async (event) => {
  const { settings } = resolveOidcSettings(process.env)
  if (!settings) {
    throw createError({ statusCode: 404, message: 'OpenID Connect sign-in is not configured', data: { code: 'auth/oidc-disabled' } })
  }
  const secret = useRuntimeConfig(event).session.password
  const redirectUri = redirectUriFor(event, settings)
  const query = getQuery(event)
  const isCallback = query.code !== undefined || query.error !== undefined || query.state !== undefined

  let config
  try {
    config = await getOidcConfiguration(settings)
  } catch (err) {
    console.warn(`[auth/oidc] discovery failed for ${settings.issuer.href}: ${describeError(err)}`)
    throw createError({
      statusCode: 502,
      message: 'The identity provider could not be reached.',
      data: { code: 'auth/oidc-unavailable' }
    })
  }

  if (!isCallback) {
    const { url, flow } = await buildOidcAuthorizationRequest(config, settings, redirectUri)
    setCookie(event, OIDC_FLOW_COOKIE, encodeFlowCookie(flow, secret), {
      httpOnly: true,
      secure: !isDevelopment,
      sameSite: 'lax',
      path: '/auth/oidc',
      maxAge: OIDC_FLOW_MAX_AGE_SECONDS
    })
    return sendRedirect(event, url.href)
  }

  // Single use: drop the flow cookie before anything can fail.
  const flow = decodeFlowCookie(getCookie(event, OIDC_FLOW_COOKIE), secret)
  deleteCookie(event, OIDC_FLOW_COOKIE, { path: '/auth/oidc' })
  if (!flow) {
    console.warn('[auth/oidc] callback without a valid flow cookie (expired, forged or another browser)')
    throw loginFailed()
  }

  const callbackUrl = new URL(redirectUri)
  callbackUrl.search = getRequestURL(event).search

  let profile
  try {
    profile = await completeOidcAuthorization(config, callbackUrl, flow)
  } catch (err) {
    console.warn(`[auth/oidc] sign-in rejected: ${describeError(err)}`)
    throw loginFailed()
  }

  const { userId, outcome } = await upsertOAuthUser({
    provider: 'oidc',
    oidcIssuer: profile.issuer,
    providerUserId: profile.subject,
    name: profile.name,
    // Null unless the IdP asserted email_verified=true (profile.ts).
    email: profile.email,
    emailVerified: profile.emailVerified
  })

  // Same allowlist bootstrap as GitHub/Google; only ever sees a
  // verified email because unverified ones were dropped above.
  await bootstrapAdminFromEnv({ userId, email: profile.email })

  await setUserSession(event, {
    user: {
      id: userId,
      name: profile.name,
      email: profile.email,
      provider: 'oidc'
    },
    loggedInAt: Date.now(),
    // Current session epoch; a later "log out everywhere" bumps it.
    e: await getSessionEpoch(userId),
    v: SESSION_VERSION
  })
  const target = outcome === 'merged' ? '/?linked=oidc' : '/'
  return sendRedirect(event, target)
})
