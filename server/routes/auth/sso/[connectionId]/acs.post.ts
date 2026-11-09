import { AUDIT_SSO_SIGN_IN } from '../../../../legal/auditActions'
import { appendAuditEvent } from '../../../../repos/audit'
import { getSsoConnectionById } from '../../../../repos/sso'
import { ssoErrorPath, takeSsoFlowCookie } from '../../../../utils/sso/http'
import { assertionFromSamlProfile, samlFor } from '../../../../utils/sso/saml'
import { finishSsoSignIn } from '../../../../utils/sso/finish'

// POST /auth/sso/:connectionId/acs — SAML assertion consumer service
// (HTTP-POST binding) for a workspace's identity provider (WP14).
// Validation rules: `server/utils/sso/saml.ts`. Only SP-initiated
// sign-ins: the response must answer the AuthnRequest whose id is in
// THIS browser's flow cookie.
const MAX_RESPONSE_BYTES = 512 * 1024

export default defineEventHandler(async (event) => {
  const connectionId = getRouterParam(event, 'connectionId') ?? ''
  const flow = takeSsoFlowCookie(event)
  const connection = /^[\w-]{1,64}$/.test(connectionId) ? await getSsoConnectionById(connectionId) : null
  if (!connection || connection.protocol !== 'saml') return sendRedirect(event, ssoErrorPath('sso/unknown'))
  if (!flow || flow.connectionId !== connection.id || !flow.requestId) {
    console.warn('[auth/sso] SAML response without a valid flow cookie (expired, unsolicited or another browser)')
    return sendRedirect(event, ssoErrorPath('sso/failed', connection.workspaceId))
  }

  const body = await readBody<Record<string, unknown>>(event).catch(() => null)
  const samlResponse = typeof body?.SAMLResponse === 'string' ? body.SAMLResponse : ''
  if (!samlResponse || samlResponse.length > MAX_RESPONSE_BYTES) return sendRedirect(event, ssoErrorPath('sso/failed', connection.workspaceId))

  let assertion
  try {
    const saml = samlFor(event, connection, { boundRequestId: flow.requestId })
    const { profile, loggedOut } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse })
    if (loggedOut || !profile) throw new Error('not a sign-in response')
    assertion = assertionFromSamlProfile(profile)
  } catch (err) {
    console.warn(`[auth/sso] SAML response rejected for connection ${connection.id}: ${err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error'}`)
    await appendAuditEvent({
      actorUserId: null,
      actorIp: getClientIp(event),
      scope: 'workspace',
      scopeId: connection.workspaceId,
      action: AUDIT_SSO_SIGN_IN,
      metadata: { protocol: 'saml', outcome: 'rejected' }
    })
    return sendRedirect(event, ssoErrorPath('sso/failed', connection.workspaceId))
  }
  return finishSsoSignIn(event, connection, flow, assertion)
})
