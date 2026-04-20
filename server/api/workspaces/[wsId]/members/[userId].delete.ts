import { and, eq } from 'drizzle-orm'
import { workspaceMembers } from '../../../../db/schema'

// Remove a member OR leave the workspace. Same endpoint because "remove"
// and "leave" are the same underlying row deletion — only the authorisation
// differs:
//   - An admin may remove any other member (including other admins).
//   - Any non-admin may remove themselves (leave) but never anyone else.
//   - Admins can also remove themselves (leave) provided they're not the
//     last admin — the "at least one admin" invariant would otherwise be
//     broken.
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

  const db = useDatabase()
  const existing = (await db.select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, targetUserId)))
    .limit(1))[0]
  if (!existing) throw createError({ statusCode: 404, message: 'Member not found' })

  // Last-admin guard: whether self-leaving or being removed, refuse to drop
  // the final admin. The remaining workspace would have no one who can
  // manage membership or delete it.
  if (existing.role === 'admin') {
    const adminCount = await countWorkspaceAdmins(wsId)
    if (adminCount <= 1) {
      throw createError({ statusCode: 409, message: 'Workspace must have at least one admin — promote someone else first, or delete the workspace.' })
    }
  }

  await db.delete(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, targetUserId)))

  return { success: true }
})
