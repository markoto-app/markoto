import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_SSO_SCIM_USER_CREATED } from '../../../../legal/auditActions'
import { createScimUser, defineScimHandler, getScimUser, readScimBody, scimUserResource } from '../../../../utils/sso/scim'

// POST /scim/v2/Users — provision a member (WP14). 201 + the User.
export default defineScimHandler(async (event, connection) => {
  const { identity, created } = await createScimUser(connection, await readScimBody(event))
  await appendAuditEvent({ actorUserId: null, actorIp: getClientIp(event), scope: 'workspace', scopeId: connection.workspaceId, action: AUDIT_SSO_SCIM_USER_CREATED, metadata: { affectedUserId: identity.userId, accountCreated: created, active: identity.active } })
  setResponseStatus(event, 201)
  return scimUserResource(event, (await getScimUser(connection.id, identity.id))!)
})
