import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_SSO_SCIM_USER_DEACTIVATED } from '../../../../legal/auditActions'
import { defineScimHandler, getScimUser, readScimBody, replaceScimUser, requireScimIdentity, scimUserResource } from '../../../../utils/sso/scim'

// PUT /scim/v2/Users/:id — replace: `active` and `externalId` apply.
export default defineScimHandler(async (event, connection) => {
  const identity = await requireScimIdentity(connection, getRouterParam(event, 'id'))
  await replaceScimUser(connection, identity, await readScimBody(event))
  const after = (await getScimUser(connection.id, identity.id))!
  if (identity.active && !after.active) {
    await appendAuditEvent({ actorUserId: null, actorIp: getClientIp(event), scope: 'workspace', scopeId: connection.workspaceId, action: AUDIT_SSO_SCIM_USER_DEACTIVATED, metadata: { affectedUserId: identity.userId } })
  }
  return scimUserResource(event, after)
})
