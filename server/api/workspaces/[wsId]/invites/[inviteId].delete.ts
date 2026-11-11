import { deleteWorkspaceInvite } from '../../../../repos/workspaceInvites'
import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_WORKSPACE_INVITE_REVOKED } from '../../../../legal/auditActions'
import { parseInviteId } from '../../../../utils/workspaces/workspaceInvites'

// DELETE /api/workspaces/:wsId/invites/:inviteId — revoke an open
// invitation. Admin-only. Keyed on (workspace, invite id): another
// workspace's invite id is a plain 404.
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  const inviteId = parseInviteId(getRouterParam(event, 'inviteId'))
  if (!inviteId) throw createError({ statusCode: 400, message: 'Invalid invite id' })

  const role = await getWorkspaceRole(session.user.id, wsId)
  if (role === null) throw createError({ statusCode: 404, message: 'Workspace not found' })
  if (role !== 'admin') {
    throw createError({ statusCode: 403, message: 'Only admins can revoke invitations' })
  }

  const removed = await deleteWorkspaceInvite(wsId, inviteId)
  if (!removed) throw createError({ statusCode: 404, message: 'Invitation not found' })

  await appendAuditEvent({
    actorUserId: session.user.id,
    actorIp: getClientIp(event),
    scope: 'workspace',
    scopeId: wsId,
    action: AUDIT_WORKSPACE_INVITE_REVOKED,
    before: null,
    after: null,
    metadata: { inviteId, role: removed.role }
  })

  return { ok: true }
})
