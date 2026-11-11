import { AUDIT_SSO_SIGN_IN } from '../../../../legal/auditActions'
import { appendAuditEvent } from '../../../../repos/audit'
import { getSsoConnectionById } from '../../../../repos/sso'
import { completeOidcAuthorization, getOidcConfiguration } from '../../../../utils/oidc/client'
import { oidcSettingsForConnection, ssoErrorPath, takeSsoFlowCookie } from '../../../../utils/sso/http'
import { finishSsoSignIn } from '../../../../utils/sso/finish'

// GET /auth/sso/:connectionId/callback — OIDC redirect back from a
// workspace's identity provider. The flow cookie (signed, single
// use, bound to this connection) carries state / nonce / PKCE; the ID
// token is fully validated by openid-client (signature against the IdP's
// JWKS, iss, aud, exp, nonce); every request to the IdP goes through the
// SSRF policy (`server/utils/sso/urlPolicy.ts`).
export default defineEventHandler(async (event) => {
  const connectionId = getRouterParam(event, 'connectionId') ?? ''
  const flow = takeSsoFlowCookie(event)
  const connection = /^[\w-]{1,64}$/.test(connectionId) ? await getSsoConnectionById(connectionId) : null
  if (!connection || connection.protocol !== 'oidc') return sendRedirect(event, ssoErrorPath('sso/unknown'))
  if (!flow || flow.connectionId !== connection.id || !flow.state || !flow.nonce || !flow.codeVerifier) {
    console.warn('[auth/sso] OIDC callback without a valid flow cookie (expired, forged or another browser)')
    return sendRedirect(event, ssoErrorPath('sso/failed', connection.workspaceId))
  }

  const settings = oidcSettingsForConnection(event, connection)
  const callbackUrl = new URL(settings.redirectUrl!)
  callbackUrl.search = getRequestURL(event).search
  let profile
  try {
    const config = await getOidcConfiguration(settings)
    profile = await completeOidcAuthorization(config, callbackUrl, { state: flow.state, nonce: flow.nonce, codeVerifier: flow.codeVerifier })
  } catch (err) {
    console.warn(`[auth/sso] OIDC sign-in rejected for connection ${connection.id}: ${err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error'}`)
    await appendAuditEvent({
      actorUserId: null,
      actorIp: getClientIp(event),
      scope: 'workspace',
      scopeId: connection.workspaceId,
      action: AUDIT_SSO_SIGN_IN,
      metadata: { protocol: 'oidc', outcome: 'rejected' }
    })
    return sendRedirect(event, ssoErrorPath('sso/failed', connection.workspaceId))
  }

  return finishSsoSignIn(event, connection, flow, {
    subject: profile.subject,
    // profile.ts keeps the address only when the IdP says it is verified;
    // completeLogin additionally requires a verified domain.
    email: profile.email,
    emailVerified: profile.emailVerified,
    name: profile.name
  })
})
