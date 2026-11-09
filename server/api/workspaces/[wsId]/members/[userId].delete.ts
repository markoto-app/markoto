import { getMemberRole, removeMember } from '../../../../repos/workspaceMembers'
import { listDocIdsInWorkspace } from '../../../../repos/documents'
import { LastAdminError, NotFoundError, isRepoError } from '../../../../repos/errors'
import { notifySyncKickUser } from '../../../../utils/syncNotify'
import { appendAuditEvent } from '../../../../repos/audit'
import { deleteMemberKey } from '../../../../utils/litellm/workspaceTeams'

// Remove a member OR leave the workspace. Same endpoint because "remove"
// and "leave" are the same underlying row deletion — only the
// authorisation differs:
//   - An admin may remove any other member (including other admins).
//   - Any non-admin may remove themselves (leave) but never anyone else.
//   - Admins can also remove themselves (leave) provided they're not the
//     last admin — the "at least one admin" invariant would otherwise
//     be broken. `removeMember` enforces that invariant transactionally.
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  const targetUserId = Number(requireRouteParam(event, 'userId'))
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    throw createError({ statusCode: 400, message: 'Invalid userId' })
  }

  const myRole = await getWorkspaceRole(session.user.id, wsId)
  if (myRole === null) throw createError({ statusCode: 404, message: 'Workspace not found' })

  const isSelf = targetUserId === session.user.id
  if (!isSelf && myRole !== 'admin') {
    throw createError({ statusCode: 403, message: 'Only admins can remove other members' })
  }

  // Capture the removed member's role BEFORE the delete so the audit
  // row can record what they had. Cheap extra query — this endpoint
  // isn't hot-path.
  const targetRoleBefore = await getMemberRole(wsId, targetUserId)

  // Team / Business (WP3): the member's key in the workspace's LiteLLM
  // team goes with the membership. Deleted first (the row holds the
  // token); if the removal is then refused the key is simply re-created
  // on the next AI use.
  if (targetRoleBefore !== null) await deleteMemberKey(wsId, targetUserId)

  try {
    await removeMember(wsId, targetUserId)
  } catch (e) {
    if (e instanceof NotFoundError) throw createError({ statusCode: 404, message: 'Member not found' })
    if (e instanceof LastAdminError) throw createError({ statusCode: 409, message: e.message })
    if (isRepoError(e)) throw createError({ statusCode: e.httpStatus, message: e.message })
    throw e
  }

  // Kick any live Y.js connections the removed member holds to workspace
  // docs. Without this the member's 2h JWT stays valid and they keep
  // edit rights on docs they just lost access to. Owner-owned docs in
  // the workspace are also kicked but re-grant via the owner path on
  // reconnect.
  const wsDocIds = await listDocIdsInWorkspace(wsId)
  notifySyncKickUser(targetUserId, wsDocIds)

  const ip = getClientIp(event)
  await appendAuditEvent({
    actorUserId: session.user.id,
    actorIp: ip,
    scope: 'workspace',
    scopeId: wsId,
    action: 'workspace.member_removed',
    before: { role: targetRoleBefore },
    after: null,
    metadata: { affectedUserId: targetUserId, workspaceId: wsId, isSelf }
  })

  return { success: true }
})
