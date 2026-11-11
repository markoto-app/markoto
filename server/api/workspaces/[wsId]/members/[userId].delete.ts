import { getMembershipRole, removeMember } from '../../../../repos/workspaceMembers'
import { deleteSharesForUserInWorkspace } from '../../../../repos/documentShares'
import { listDocIdsInWorkspace } from '../../../../repos/documents'
import { LastAdminError, NotFoundError } from '../../../../repos/errors'
import { notifySyncKickUser } from '../../../../utils/documents/syncNotify'
import { appendAuditEvent } from '../../../../repos/audit'
import { deleteMemberKey } from '../../../../utils/litellm/workspaceTeams'
import { workspaceMemberParams } from '~~/shared/api/workspaces'

// Remove a member OR leave the workspace. Same endpoint because "remove"
// and "leave" are the same underlying row deletion — only the
// authorisation differs:
//   - An admin may remove any other member (including other admins).
//   - Any non-admin may remove themselves (leave) but never anyone else.
//   - Admins can also remove themselves (leave) provided they're not the
//     last admin — the "at least one admin" invariant would otherwise
//     be broken. `removeMember` enforces that invariant transactionally.
export default defineApiHandler({
  // Not `allow.workspace`: a guest has no workspace role but may still leave
  // on their own, and a non-admin may only remove themselves.
  access: allow.custom('a member removes someone (admin) or leaves (any member, incl. a guest)', {
    sessionless: false,
    check: async (_event, input, gate) => {
      if (!gate.user) throw apiError('auth/required')
      const { wsId, userId: targetUserId } = input.params as { wsId: string, userId: number }
      const isSelf = targetUserId === gate.user.id
      const myRole = await getWorkspaceRole(gate.user.id, wsId)
      // A guest has no workspace role but may leave on their own.
      const leavingGuest = myRole === null && isSelf && (await getMembershipRole(wsId, gate.user.id)) === 'guest'
      if (myRole === null && !leavingGuest) throw apiError('workspace/not-found')
      if (!isSelf && myRole !== 'admin') throw apiError('workspace/admin-required')
      return { user: gate.user, wsId, targetUserId, isSelf }
    }
  }),
  params: workspaceMemberParams,
  handler: async ({ event, user, wsId, targetUserId, isSelf }) => {
    // Capture the removed member's role BEFORE the delete so the audit
    // row can record what they had. Cheap extra query — this endpoint
    // isn't hot-path.
    // The TARGET's membership, regardless of single sign-on — a
    // member who hasn't signed in through the IdP is still a member — and
    // including guests.
    const targetRoleBefore = await getMembershipRole(wsId, targetUserId)

    // Team / Business: the member's key in the workspace's LiteLLM
    // team goes with the membership. Deleted first (the row holds the
    // token); if the removal is then refused the key is simply re-created
    // on the next AI use.
    if (targetRoleBefore !== null && targetRoleBefore !== 'guest') await deleteMemberKey(wsId, targetUserId)

    try {
      await removeMember(wsId, targetUserId)
    } catch (e) {
      if (e instanceof NotFoundError) throw apiError('workspace/member-not-found')
      if (e instanceof LastAdminError) throw apiError('workspace/last-admin')
      throw e
    }

    // A guest's shares on this workspace's documents go with them.
    if (targetRoleBefore === 'guest') await deleteSharesForUserInWorkspace(targetUserId, wsId)

    // Kick any live Y.js connections the removed member holds to workspace
    // docs. Without this the member's 2h JWT stays valid and they keep
    // edit rights on docs they just lost access to. Owner-owned docs in
    // the workspace are also kicked but re-grant via the owner path on
    // reconnect.
    const wsDocIds = await listDocIdsInWorkspace(wsId)
    notifySyncKickUser(targetUserId, wsDocIds)

    const ip = getClientIp(event)
    await appendAuditEvent({
      actorUserId: user.id,
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
