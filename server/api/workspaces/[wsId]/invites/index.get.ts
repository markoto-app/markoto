import { listWorkspaceInvites } from '../../../../repos/workspaceInvites'

// GET /api/workspaces/:wsId/invites: open invitations. Admin-only.
// Shows the address the admin typed, the role and who invited; never
// whether the address belongs to an account.
export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'workspace/admin-required' }),
  handler: async ({ workspaceAccess }) => {
    const rows = await listWorkspaceInvites(workspaceAccess, new Date())
    return rows.map(r => ({
      inviteId: r.inviteId,
      email: r.email,
      role: r.role,
      invitedByName: r.invitedByName,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString()
    }))
  }
})
