import { appendAuditEvent } from '../../../../repos/audit'
import { getSsoConnectionForWorkspace, setScimTokenHash } from '../../../../repos/sso'
import { AUDIT_SSO_SCIM_TOKEN_ROTATED } from '../../../../legal/auditActions'
import { assertSsoPlan, requireSsoAdmin } from '../../../../utils/sso/admin'
import { hashScimToken, newScimToken } from '../../../../utils/sso/scim'
import { ssoBaseUrl } from '../../../../utils/sso/http'

// POST /api/workspaces/:wsId/sso/scim-token — create (or replace) the
// SCIM bearer token for the workspace's IdP (WP14). Returned ONCE; only
// its SHA-256 is stored. The previous token stops working at once.
export default defineEventHandler(async (event) => {
  const { userId, wsId } = await requireSsoAdmin(event)
  await assertSsoPlan(wsId)
  const connection = await getSsoConnectionForWorkspace(wsId)
  if (!connection) throw createError({ statusCode: 409, message: 'Set up single sign-on first.', data: { code: 'sso/no-connection' } })
  const token = newScimToken()
  await setScimTokenHash(connection.id, hashScimToken(token))
  await appendAuditEvent({ actorUserId: userId, actorIp: getClientIp(event), scope: 'workspace', scopeId: wsId, action: AUDIT_SSO_SCIM_TOKEN_ROTATED, metadata: { revoked: false } })
  setHeader(event, 'cache-control', 'no-store')
  return { token, baseUrl: `${ssoBaseUrl(event)}/scim/v2` }
})
