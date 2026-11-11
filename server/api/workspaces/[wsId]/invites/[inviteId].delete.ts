import { deleteWorkspaceInvite } from '../../../../repos/workspaceInvites'
import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_WORKSPACE_INVITE_REVOKED } from '../../../../legal/auditActions'
import { workspaceInviteParams } from '~~/shared/api/workspaces'

// DELETE /api/workspaces/:wsId/invites/:inviteId — revoke an open
// invitation. Admin-only. Keyed on (workspace, invite id): another
// workspace's invite id is a plain 404.
export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'workspace/admin-required' }),
  params: workspaceInviteParams,
  handler: async ({ event, user, wsId, params }) => {
    const inviteId = params.inviteId
    const removed = await deleteWorkspaceInvite(wsId, inviteId)
    if (!removed) throw apiError('workspace/invite-not-found')

    await appendAuditEvent({
      actorUserId: user.id,
      actorIp: getClientIp(event),
      scope: 'workspace',
      scopeId: wsId,
      action: AUDIT_WORKSPACE_INVITE_REVOKED,
      before: null,
      after: null,
      metadata: { inviteId, role: removed.role }
    })

    return { ok: true }
  }
})
