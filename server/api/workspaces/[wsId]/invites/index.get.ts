import { listWorkspaceInvites } from '../../../../repos/workspaceInvites'

// GET /api/workspaces/:wsId/invites — open invitations. Admin-only.
// Shows the address the admin typed, the role and who invited; never
// whether the address belongs to an account.
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)

  const role = await getWorkspaceRole(session.user.id, wsId)
  if (role === null) throw createError({ statusCode: 404, message: 'Workspace not found' })
  if (role !== 'admin') {
    throw createError({ statusCode: 403, message: 'Only admins can see invitations' })
  }

  const rows = await listWorkspaceInvites(wsId, new Date())
  return rows.map(r => ({
    inviteId: r.inviteId,
    email: r.email,
    role: r.role,
    invitedByName: r.invitedByName,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString()
  }))
})
