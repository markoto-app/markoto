// HTTP plumbing shared by the routes under `server/routes/auth/sso/`: the
// public base URL, the flow cookie, the session, errors, and the
// per-connection OIDC settings.

import type { H3Event } from 'h3'
import { isTestModeEnabled } from '~~/shared/utils/security/testMode'
import { openSecretOrNull, secretContext } from '../platform/secretBox'
import { SESSION_VERSION } from '../auth/validatedSession'
import { getSessionEpoch } from '../../repos/users'
import type { OidcSettings } from '../oidc/settings'
import type { SsoConnectionRow } from '../../repos/sso'
import { createSsoFetch, ssoAllowsPrivateUrls } from './urlPolicy'
import {
  SSO_FLOW_COOKIE,
  SSO_FLOW_COOKIE_PATH,
  SSO_FLOW_MAX_AGE_SECONDS,
  decodeSsoFlow,
  encodeSsoFlow,
  type SsoFlow
} from './flowCookie'
import type { SsoLoginResult } from './completeLogin'
import { useEnv } from '~~/shared/env/load'
import { apiError } from '../api/apiError'
import { trimTrailingSlashes } from '~~/shared/utils/trimTrailingSlashes'

/**
 * The origin markoto is reached at (`NUXT_SITE_URL`). Callback URLs and
 * the SAML entity id are built from it, never from the request Host. In
 * test mode without a site URL, the request origin.
 */
export function ssoBaseUrl(event: H3Event): string {
  const site = String(useEnv().core.siteUrl ?? '').trim()
  if (site) return trimTrailingSlashes(site)
  if (isTestModeEnabled()) return getRequestURL(event).origin
  throw apiError('sso/misconfigured')
}

export function ssoCallbackUrl(event: H3Event, connectionId: string): string {
  return `${ssoBaseUrl(event)}/auth/sso/${encodeURIComponent(connectionId)}/callback`
}

export function samlAcsUrl(event: H3Event, connectionId: string): string {
  return `${ssoBaseUrl(event)}/auth/sso/${encodeURIComponent(connectionId)}/acs`
}

/** Our SAML entity id (= the metadata URL), unique per connection. */
export function samlSpEntityId(event: H3Event, connectionId: string): string {
  return `${ssoBaseUrl(event)}/auth/sso/${encodeURIComponent(connectionId)}/metadata`
}

// SAML posts back from the IdP's site: a cross-site POST, on which
// browsers don't send SameSite=Lax cookies. So the flow cookie is
// SameSite=None (+ Secure) wherever the site is https. It is signed,
// httpOnly, path-scoped and single use; plain-http dev / test keeps Lax.
function flowCookieOptions(event: H3Event) {
  const secure = ssoBaseUrl(event).startsWith('https://')
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' as const : 'lax' as const,
    path: SSO_FLOW_COOKIE_PATH,
    maxAge: SSO_FLOW_MAX_AGE_SECONDS
  }
}

export function setSsoFlowCookie(event: H3Event, flow: SsoFlow): void {
  const secret = useRuntimeConfig(event).session.password
  setCookie(event, SSO_FLOW_COOKIE, encodeSsoFlow(flow, secret), flowCookieOptions(event))
}

/** Read AND delete the flow cookie (single use). */
export function takeSsoFlowCookie(event: H3Event): SsoFlow | null {
  const secret = useRuntimeConfig(event).session.password
  const flow = decodeSsoFlow(getCookie(event, SSO_FLOW_COOKIE), secret)
  deleteCookie(event, SSO_FLOW_COOKIE, { path: SSO_FLOW_COOKIE_PATH })
  return flow
}

/** The signed-in session after a successful SSO sign-in. */
export async function setSsoSession(event: H3Event, result: SsoLoginResult): Promise<void> {
  await setUserSession(event, {
    user: { id: result.userId, name: result.name, email: result.email, provider: 'sso' },
    loggedInAt: Date.now(),
    e: await getSessionEpoch(result.userId),
    v: SESSION_VERSION
  })
}

/** Where to go after a successful sign-in. */
export function afterSsoLoginPath(result: SsoLoginResult, flow: SsoFlow): string {
  if (flow.purpose === 'test') return `/w/${encodeURIComponent(result.workspaceId)}?tab=sso&test=${result.activated ? 'activated' : 'ok'}`
  return flow.returnTo ?? `/w/${encodeURIComponent(result.workspaceId)}`
}

/**
 * A refused or failed sign-in lands on a page that explains it (no raw
 * error text from the IdP, only our fixed codes).
 */
export function ssoErrorPath(code: string, workspaceId?: string): string {
  const q = new URLSearchParams({ code })
  if (workspaceId) q.set('workspace', workspaceId)
  return `/auth/sso-error?${q.toString()}`
}

/** openid-client settings for a workspace's OIDC connection. */
export function oidcSettingsForConnection(event: H3Event, connection: SsoConnectionRow): OidcSettings & { redirectUrl: string } {
  if (connection.protocol !== 'oidc' || !connection.oidcIssuer || !connection.oidcClientId || !connection.oidcClientSecret) {
    throw apiError('sso/incomplete')
  }
  const clientSecret = openSecretOrNull('sso-client-secret', secretContext.ssoClientSecret(connection.workspaceId), connection.oidcClientSecret)
  if (clientSecret === null) {
    // Encryption key lost or rotated away: a workspace admin enters the
    // client secret again (the settings stay reachable via the break-glass).
    throw apiError('sso/incomplete')
  }
  const allowPrivate = ssoAllowsPrivateUrls()
  return {
    issuer: new URL(connection.oidcIssuer),
    clientId: connection.oidcClientId,
    clientSecret,
    scopes: ['openid', 'email', 'profile'],
    redirectUrl: ssoCallbackUrl(event, connection.id),
    // http only reaches a private address (enforced by the fetch policy).
    allowInsecureHttp: allowPrivate,
    fetch: createSsoFetch({ allowPrivate }),
    cacheScope: `sso:${connection.id}`
  }
}
