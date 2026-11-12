import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_SSO_SCIM_USER_DEACTIVATED } from '../../../../legal/auditActions'
import { requireScimUser, patchScimUser, requireScimIdentity, scimUserResource } from '../../../../utils/sso/scim'
import { scimResourceBody, scimUserParams } from '~~/shared/api/sso'

// PATCH /scim/v2/Users/:id — PatchOp; `active` + `externalId`.
export default defineApiHandler({
  access: allow.scim(),
  params: scimUserParams,
  body: scimResourceBody,
  handler: async ({ event, connection, params, body }) => {
    const identity = await requireScimIdentity(connection, params.id)
    await patchScimUser(connection, identity, body)
    const after = await requireScimUser(connection.id, identity.id)
    if (identity.active && !after.active) {
      await appendAuditEvent({ actorUserId: null, actorIp: getClientIp(event), scope: 'workspace', scopeId: connection.workspaceId, action: AUDIT_SSO_SCIM_USER_DEACTIVATED, metadata: { affectedUserId: identity.userId } })
    }
    return scimUserResource(event, after)
  }
})
