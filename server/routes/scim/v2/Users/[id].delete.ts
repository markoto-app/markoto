import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_SSO_SCIM_USER_DEACTIVATED } from '../../../../legal/auditActions'
import { deleteScimUser, requireScimIdentity } from '../../../../utils/sso/scim'
import { scimUserParams } from '~~/shared/api/sso'

// DELETE /scim/v2/Users/:id — out of the workspace; the account stays.
export default defineApiHandler({
  access: allow.scim(),
  params: scimUserParams,
  handler: async ({ event, connection, params, workspaceAccess }) => {
    const identity = await requireScimIdentity(connection, params.id)
    await deleteScimUser(connection, identity)
    await appendAuditEvent({ by: workspaceAccess, actorIp: getClientIp(event), scope: 'workspace', scopeId: connection.workspaceId, action: AUDIT_SSO_SCIM_USER_DEACTIVATED, metadata: { affectedUserId: identity.userId, deleted: true } })
    setResponseStatus(event, 204)
    return null
  }
})
