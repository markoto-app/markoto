import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_SSO_SCIM_USER_CREATED } from '../../../../legal/auditActions'
import { createScimUser, requireScimUser, scimUserResource } from '../../../../utils/sso/scim'
import { scimResourceBody } from '~~/shared/api/sso'

// POST /scim/v2/Users — provision a member. 201 + the User.
export default defineApiHandler({
  access: allow.scim(),
  body: scimResourceBody,
  handler: async ({ event, connection, body }) => {
    const { identity, created } = await createScimUser(connection, body)
    await appendAuditEvent({ actorUserId: null, actorIp: getClientIp(event), scope: 'workspace', scopeId: connection.workspaceId, action: AUDIT_SSO_SCIM_USER_CREATED, metadata: { affectedUserId: identity.userId, accountCreated: created, active: identity.active } })
    setResponseStatus(event, 201)
    return scimUserResource(event, await requireScimUser(connection.id, identity.id))
  }
})
