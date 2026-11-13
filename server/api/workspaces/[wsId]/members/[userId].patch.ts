import { setRole } from '../../../../repos/workspaceMembers'
import { listDocIdsInWorkspace } from '../../../../repos/documents'
import { ConflictError, LastAdminError, NotFoundError } from '../../../../repos/errors'
import { notifySyncKickUser } from '../../../../utils/documents/syncNotify'
import { appendAuditEvent } from '../../../../repos/audit'
import { updateMemberRoleBody, workspaceMemberParams } from '~~/shared/api/workspaces'

// Change a member's role. Admin-only.
//
// Invariant: a workspace must always have at least one admin. Demoting
// the last admin is refused, the admin should promote someone else
// first, or delete the workspace outright. `setRole` enforces this
// transactionally (count + update in the same tx so two concurrent
// demotions can't both win).
export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'workspace/admin-required' }),
  params: workspaceMemberParams,
  body: updateMemberRoleBody,
  handler: async ({ event, wsId, params, body, workspaceAccess }) => {
    const targetUserId = params.userId
    const nextRole = body.role

    let previousRole: 'admin' | 'editor' | 'viewer'
    try {
      previousRole = await setRole(workspaceAccess, targetUserId, nextRole)
    } catch (e) {
      if (e instanceof NotFoundError) throw apiError('workspace/member-not-found')
      if (e instanceof LastAdminError) throw apiError('workspace/last-admin')
      // Any other conflict the repo raises (a guest has no role to change).
      if (e instanceof ConflictError) throw apiError('workspace/guest-role-change')
      throw e
    }

    if (previousRole === nextRole) {
      return { success: true, noop: true }
    }

    // Kick the member on every workspace doc so their next token reflects
    // the new role. We always kick, even when the role loosens (editor →
    // admin): because the alternative is maintaining a "does this change
    // reduce access" predicate, and any mistake there becomes a stale-JWT
    // security bug. Reconnect cost is a UI flicker; wrong call is a hole.
    const wsDocIds = await listDocIdsInWorkspace(workspaceAccess)
    notifySyncKickUser(targetUserId, wsDocIds)

    const ip = getClientIp(event)
    await appendAuditEvent({
      by: workspaceAccess,
      actorIp: ip,
      scope: 'workspace',
      scopeId: wsId,
      action: 'workspace.member_role_changed',
      before: { role: previousRole },
      after: { role: nextRole },
      metadata: { affectedUserId: targetUserId, workspaceId: wsId }
    })

    return { success: true }
  }
})
