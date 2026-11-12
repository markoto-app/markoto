import { listSharedWithUser } from '../../repos/documentShares'

// GET /api/user/shared-documents: documents shared with me as a GUEST
// of a workspace: the guest's only way into a workspace. The
// dashboard lists them under "Shared with you".
export default defineApiHandler({
  access: allow.user(),
  handler: async ({ self }) => {
    const rows = await listSharedWithUser(self)
    return rows.map(r => ({
      docId: r.docId,
      title: r.title,
      access: r.access,
      workspaceId: r.workspaceId,
      workspaceName: r.workspaceName,
      lastActive: r.lastActive?.toISOString() ?? null
    }))
  }
})
