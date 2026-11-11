import { appendAuditEvent } from '../../../../repos/audit'
import { getSsoConnectionForWorkspace, setScimTokenHash } from '../../../../repos/sso'
import { AUDIT_SSO_SCIM_TOKEN_ROTATED } from '../../../../legal/auditActions'
import { requireSsoAdmin } from '../../../../utils/sso/admin'

// DELETE /api/workspaces/:wsId/sso/scim-token — switch provisioning off.
export default defineEventHandler(async (event) => {
  const { userId, wsId } = await requireSsoAdmin(event)
  const connection = await getSsoConnectionForWorkspace(wsId)
  if (connection) await setScimTokenHash(connection.id, null)
  await appendAuditEvent({ actorUserId: userId, actorIp: getClientIp(event), scope: 'workspace', scopeId: wsId, action: AUDIT_SSO_SCIM_TOKEN_ROTATED, metadata: { revoked: true } })
  return { ok: true }
})
