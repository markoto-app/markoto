import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_SSO_SCIM_USER_DEACTIVATED } from '../../../../legal/auditActions'
import { defineScimHandler, deleteScimUser, requireScimIdentity } from '../../../../utils/sso/scim'

// DELETE /scim/v2/Users/:id — out of the workspace; the account stays.
export default defineScimHandler(async (event, connection) => {
  const identity = await requireScimIdentity(connection, getRouterParam(event, 'id'))
  await deleteScimUser(connection, identity)
  await appendAuditEvent({ actorUserId: null, actorIp: getClientIp(event), scope: 'workspace', scopeId: connection.workspaceId, action: AUDIT_SSO_SCIM_USER_DEACTIVATED, metadata: { affectedUserId: identity.userId, deleted: true } })
  setResponseStatus(event, 204)
  return null
})
