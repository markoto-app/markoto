import { appendAuditEvent } from '../../../../repos/audit'
import { getSsoConnectionForWorkspace, setScimTokenHash } from '../../../../repos/sso'
import { AUDIT_SSO_SCIM_TOKEN_ROTATED } from '../../../../legal/auditActions'

// DELETE /api/workspaces/:wsId/sso/scim-token — switch provisioning off.
// Without the plan too: switching off must always work.
export default defineApiHandler({
  access: allow.workspace('admin', { ignoreSso: true, deny: 'sso/admin-required' }),
  handler: async ({ event, user, wsId }) => {
    const connection = await getSsoConnectionForWorkspace(wsId)
    if (connection) await setScimTokenHash(connection.id, null)
    await appendAuditEvent({ actorUserId: user.id, actorIp: getClientIp(event), scope: 'workspace', scopeId: wsId, action: AUDIT_SSO_SCIM_TOKEN_ROTATED, metadata: { revoked: true } })
    return { ok: true }
  }
})
