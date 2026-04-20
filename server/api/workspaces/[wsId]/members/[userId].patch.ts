import { and, eq } from 'drizzle-orm'
import { documents, workspaceMembers } from '../../../../db/schema'
import { notifySyncKickUser } from '../../../../utils/syncNotify'

// Change a member's role. Admin-only.
//
// Invariant: a workspace must always have at least one admin. Demoting the
// last admin is refused — the admin should promote someone else first, or
// delete the workspace outright. Same invariant guards the DELETE path.
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

  const db = useDatabase()
  const existing = (await db.select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, targetUserId)))
    .limit(1))[0]
  if (!existing) throw createError({ statusCode: 404, message: 'Member not found' })

  // Demoting an admin? Guard against emptying the workspace of admins.
  if (existing.role === 'admin' && nextRole !== 'admin') {
    const adminCount = await countWorkspaceAdmins(wsId)
    if (adminCount <= 1) {
      throw createError({ statusCode: 409, message: 'Workspace must have at least one admin' })
    }
  }

  if (existing.role === nextRole) {
    return { success: true, noop: true }
  }

  await db.update(workspaceMembers)
    .set({ role: nextRole })
    .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, targetUserId)))

  // Kick the member on every workspace doc so their next token reflects
  // the new role. We always kick — even when the role loosens (editor →
  // admin) — because the alternative is maintaining a "does this change
  // reduce access" predicate, and any mistake there becomes a stale-JWT
  // security bug. Reconnect cost is a UI flicker; wrong call is a hole.
  const wsDocs = await db.select({ docId: documents.docId })
    .from(documents)
    .where(eq(documents.workspaceId, wsId))
  notifySyncKickUser(targetUserId, wsDocs.map(d => d.docId))

  return { success: true }
})
