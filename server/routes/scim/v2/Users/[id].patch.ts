import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_SSO_SCIM_USER_DEACTIVATED } from '../../../../legal/auditActions'
import { defineScimHandler, getScimUser, patchScimUser, readScimBody, requireScimIdentity, scimUserResource } from '../../../../utils/sso/scim'

// PATCH /scim/v2/Users/:id — PatchOp; `active` + `externalId` (WP14).
export default defineScimHandler(async (event, connection) => {
  const identity = await requireScimIdentity(connection, getRouterParam(event, 'id'))
  await patchScimUser(connection, identity, await readScimBody(event))
  const after = (await getScimUser(connection.id, identity.id))!
  if (identity.active && !after.active) {
    await appendAuditEvent({ actorUserId: null, actorIp: getClientIp(event), scope: 'workspace', scopeId: connection.workspaceId, action: AUDIT_SSO_SCIM_USER_DEACTIVATED, metadata: { affectedUserId: identity.userId } })
  }
  return scimUserResource(event, after)
})
