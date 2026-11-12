import { AUDIT_SSO_SIGN_IN } from '../../../../legal/auditActions'
import { appendAuditEvent } from '../../../../repos/audit'
import { getSsoConnectionById } from '../../../../repos/sso'
import { completeOidcAuthorization, getOidcConfiguration } from '../../../../utils/oidc/client'
import { oidcSettingsForConnection, ssoErrorPath, takeSsoFlowCookie } from '../../../../utils/sso/http'
import { finishSsoSignIn } from '../../../../utils/sso/finish'
import { ID_RE } from '~~/shared/config/identifiers'
import { ssoConnectionParams } from '~~/shared/api/sso'
import { useLogger } from '../../../../utils/platform/logger'
import { system } from '../../../../repos/proofs'

const log = useLogger('auth-sso')

// GET /auth/sso/:connectionId/callback — OIDC redirect back from a
// workspace's identity provider. The flow cookie (signed, single
// use, bound to this connection) carries state / nonce / PKCE; the ID
// token is fully validated by openid-client (signature against the IdP's
// JWKS, iss, aud, exp, nonce); every request to the IdP goes through the
// SSRF policy (`server/utils/sso/urlPolicy.ts`).
export default defineApiHandler({
  access: allow.public('the IdP redirects the browser back here; bound to this browser by the signed single-use flow cookie (state, nonce, PKCE) and validated by openid-client'),
  params: ssoConnectionParams,
  handler: async ({ event, params }) => {
    const { connectionId } = params
    const flow = takeSsoFlowCookie(event)
    const connection = ID_RE.test(connectionId) ? await getSsoConnectionById(connectionId) : null
    if (!connection || connection.protocol !== 'oidc') return sendRedirect(event, ssoErrorPath('sso/unknown'))
    if (!flow || flow.connectionId !== connection.id || !flow.state || !flow.nonce || !flow.codeVerifier) {
      log.warn('OIDC callback without a valid flow cookie (expired, forged or another browser)')
      return sendRedirect(event, ssoErrorPath('sso/failed', connection.workspaceId))
    }

    const settings = oidcSettingsForConnection(event, connection)
    const callbackUrl = new URL(settings.redirectUrl)
    callbackUrl.search = getRequestURL(event).search
    let profile
    try {
      const config = await getOidcConfiguration(settings)
      profile = await completeOidcAuthorization(config, callbackUrl, { state: flow.state, nonce: flow.nonce, codeVerifier: flow.codeVerifier })
    } catch (err) {
      log.warn('OIDC sign-in rejected', { connectionId: connection.id, err })
      await appendAuditEvent({
        by: system('sso-login'),
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
  }
})
