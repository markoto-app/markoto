import { leaveWorkspace, removeMember } from '../../../../repos/workspaceMembers'
import { getMembershipRole } from '../../../../utils/access/workspaceAccess'
import { deleteOwnSharesInWorkspace, deleteSharesForUserInWorkspace } from '../../../../repos/documentShares'
import { listDocIdsInWorkspace } from '../../../../repos/documents'
import { LastAdminError, NotFoundError } from '../../../../repos/errors'
import { notifySyncKickUser } from '../../../../utils/documents/syncNotify'
import { appendAuditEvent } from '../../../../repos/audit'
import { deleteMemberKey } from '../../../../utils/litellm/workspaceTeams'
import { workspaceMemberParams } from '~~/shared/api/workspaces'
import type { UserScope, WorkspaceAccess } from '../../../../repos/proofs'

// Remove a member OR leave the workspace. Same endpoint because "remove"
// and "leave" are the same underlying row deletion, only the
// authorisation differs:
//   - An admin may remove any other member (including other admins).
//   - Any non-admin may remove themselves (leave) but never anyone else.
//   - Admins can also remove themselves (leave) provided they're not the
//     last admin: the "at least one admin" invariant would otherwise
//     be broken. `removeMember` enforces that invariant transactionally.
/** Delete the membership row; returns the workspace's document ids. */
async function removeOrLeave(
  admin: WorkspaceAccess<'admin'> | null,
  self: UserScope,
  wsId: string,
  targetUserId: number
): Promise<string[]> {
  try {
    if (admin) {
      await removeMember(admin, targetUserId)
      return await listDocIdsInWorkspace(admin)
    }
    return (await leaveWorkspace(self, wsId)).workspaceDocIds
  } catch (e) {
    if (e instanceof NotFoundError) throw apiError('workspace/member-not-found')
    if (e instanceof LastAdminError) throw apiError('workspace/last-admin')
    throw e
  }
}

export default defineApiHandler({
  // Leaving needs no role (guests too); removing someone else needs admin.
  access: allow.workspace('admin', { orSelf: 'userId', deny: 'workspace/admin-required' }),
  params: workspaceMemberParams,
  handler: async ({ event, self, wsId, targetUserId, isSelf, workspaceAccess }) => {
    // Removing someone else: the policy required admin; leaving needs no role.
    const admin = !isSelf && workspaceAccess?.allows('admin') ? workspaceAccess : null
    if (!isSelf && !admin) throw apiError('workspace/admin-required')
    // Capture the removed member's role BEFORE the delete so the audit
    // row can record what they had. Cheap extra query, this endpoint
    // isn't hot-path.
    // The TARGET's membership, regardless of single sign-on, a
    // member who hasn't signed in through the IdP is still a member, and
    // including guests.
    const targetRoleBefore = await getMembershipRole(wsId, targetUserId)

    // Team / Business: the member's key in the workspace's LiteLLM
    // team goes with the membership. Deleted first (the row holds the
    // token); if the removal is then refused the key is simply re-created
    // on the next AI use.
    if (targetRoleBefore !== null && targetRoleBefore !== 'guest') await deleteMemberKey(wsId, targetUserId)

    const wsDocIds = await removeOrLeave(admin, self, wsId, targetUserId)

    // A guest's shares on this workspace's documents go with them.
    if (targetRoleBefore === 'guest') {
      await (admin ? deleteSharesForUserInWorkspace(admin, targetUserId) : deleteOwnSharesInWorkspace(self, wsId))
    }

    // Kick any live Y.js connections the removed member holds to workspace
    // docs. Without this the member's 2h JWT stays valid and they keep
    // edit rights on docs they just lost access to. Owner-owned docs in
    // the workspace are also kicked but re-grant via the owner path on
    // reconnect.
    notifySyncKickUser(targetUserId, wsDocIds)

    const ip = getClientIp(event)
    await appendAuditEvent({
      by: admin ?? self,
      actorIp: ip,
      scope: 'workspace',
      scopeId: wsId,
      action: 'workspace.member_removed',
      before: { role: targetRoleBefore },
      after: null,
      metadata: { affectedUserId: targetUserId, workspaceId: wsId, isSelf }
    })

    return { success: true }
  }
})
