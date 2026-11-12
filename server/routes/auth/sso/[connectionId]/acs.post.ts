import { AUDIT_SSO_SIGN_IN } from '../../../../legal/auditActions'
import { appendAuditEvent } from '../../../../repos/audit'
import { getSsoConnectionById } from '../../../../repos/sso'
import { ssoErrorPath, takeSsoFlowCookie } from '../../../../utils/sso/http'
import { assertionFromSamlProfile, samlFor } from '../../../../utils/sso/saml'
import { finishSsoSignIn } from '../../../../utils/sso/finish'
import { ID_RE } from '~~/shared/config/identifiers'
import { samlAcsBody, ssoConnectionParams } from '~~/shared/api/sso'
import { useLogger } from '../../../../utils/platform/logger'
import { system } from '../../../../repos/proofs'

const log = useLogger('auth-sso')

// POST /auth/sso/:connectionId/acs: SAML assertion consumer service
// (HTTP-POST binding) for a workspace's identity provider.
// Validation rules: `server/utils/sso/saml.ts`. Only SP-initiated
// sign-ins: the response must answer the AuthnRequest whose id is in
// THIS browser's flow cookie.
const MAX_RESPONSE_BYTES = 512 * 1024

export default defineApiHandler({
  access: allow.public('the IdP posts the signed SAML response through the browser; it must answer the AuthnRequest id in this browser\'s single-use flow cookie'),
  params: ssoConnectionParams,
  // A form post from the IdP: no session and no Origin of ours (outside /api, so no CSRF check applies).
  // Read only after the single-use flow cookie is taken: an unreadable post
  // still uses the cookie up and lands on the failure page.
  body: lenientBody(samlAcsBody),
  handler: async ({ event, params, parseBody }) => {
    const { connectionId } = params
    const flow = takeSsoFlowCookie(event)
    const connection = ID_RE.test(connectionId) ? await getSsoConnectionById(connectionId) : null
    if (!connection || connection.protocol !== 'saml') return sendRedirect(event, ssoErrorPath('sso/unknown'))
    if (!flow || flow.connectionId !== connection.id || !flow.requestId) {
      log.warn('SAML response without a valid flow cookie (expired, unsolicited or another browser)')
      return sendRedirect(event, ssoErrorPath('sso/failed', connection.workspaceId))
    }

    const body = await parseBody()
    const samlResponse = body?.SAMLResponse ?? ''
    if (!samlResponse || samlResponse.length > MAX_RESPONSE_BYTES) return sendRedirect(event, ssoErrorPath('sso/failed', connection.workspaceId))

    let assertion
    try {
      const saml = samlFor(event, connection, { boundRequestId: flow.requestId })
      const { profile, loggedOut } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse })
      if (loggedOut || !profile) throw new Error('not a sign-in response')
      assertion = assertionFromSamlProfile(profile)
    } catch (err) {
      log.warn('SAML response rejected', { connectionId: connection.id, err })
      await appendAuditEvent({
        by: system('sso-login'),
        actorIp: getClientIp(event),
        scope: 'workspace',
        scopeId: connection.workspaceId,
        action: AUDIT_SSO_SIGN_IN,
        metadata: { protocol: 'saml', outcome: 'rejected' }
      })
      return sendRedirect(event, ssoErrorPath('sso/failed', connection.workspaceId))
    }
    return finishSsoSignIn(event, connection, flow, assertion)
  }
})
