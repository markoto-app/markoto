import { setRole } from '../../../../repos/workspaceMembers'
import { listDocIdsInWorkspace } from '../../../../repos/documents'
import { LastAdminError, NotFoundError, isRepoError } from '../../../../repos/errors'
import { notifySyncKickUser } from '../../../../utils/documents/syncNotify'
import { appendAuditEvent } from '../../../../repos/audit'

// Change a member's role. Admin-only.
//
// Invariant: a workspace must always have at least one admin. Demoting
// the last admin is refused — the admin should promote someone else
// first, or delete the workspace outright. `setRole` enforces this
// transactionally (count + update in the same tx so two concurrent
// demotions can't both win).
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  const targetUserId = Number(requireRouteParam(event, 'userId'))
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    throw createError({ statusCode: 400, message: 'Invalid userId' })
  }
  const body = await readBody<{ role?: unknown }>(event)

  const myRole = await getWorkspaceRole(session.user.id, wsId)
  if (myRole === null) throw createError({ statusCode: 404, message: 'Workspace not found' })
  if (myRole !== 'admin') {
    throw createError({ statusCode: 403, message: 'Only admins can change roles' })
  }

  const nextRole = typeof body?.role === 'string' ? body.role : ''
  if (nextRole !== 'admin' && nextRole !== 'editor' && nextRole !== 'viewer') {
    throw createError({ statusCode: 400, message: 'Invalid role' })
  }

  let previousRole: 'admin' | 'editor' | 'viewer'
  try {
    previousRole = await setRole(wsId, targetUserId, nextRole)
  } catch (e) {
    if (e instanceof NotFoundError) throw createError({ statusCode: 404, message: 'Member not found' })
    if (e instanceof LastAdminError) throw createError({ statusCode: 409, message: 'Workspace must have at least one admin' })
    if (isRepoError(e)) throw createError({ statusCode: e.httpStatus, message: e.message })
    throw e
  }

  if (previousRole === nextRole) {
    return { success: true, noop: true }
  }

  // Kick the member on every workspace doc so their next token reflects
  // the new role. We always kick — even when the role loosens (editor →
  // admin) — because the alternative is maintaining a "does this change
  // reduce access" predicate, and any mistake there becomes a stale-JWT
  // security bug. Reconnect cost is a UI flicker; wrong call is a hole.
  const wsDocIds = await listDocIdsInWorkspace(wsId)
  notifySyncKickUser(targetUserId, wsDocIds)

  const ip = getClientIp(event)
  await appendAuditEvent({
    actorUserId: session.user.id,
    actorIp: ip,
    scope: 'workspace',
    scopeId: wsId,
    action: 'workspace.member_role_changed',
    before: { role: previousRole },
    after: { role: nextRole },
    metadata: { affectedUserId: targetUserId, workspaceId: wsId }
  })

  return { success: true }
})
