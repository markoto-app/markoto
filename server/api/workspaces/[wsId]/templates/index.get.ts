import { brandKitAvailable } from '../../../../utils/brandKit/access'
import { listWorkspaceTemplates } from '../../../../repos/workspaceTemplates'

// GET /api/workspaces/:wsId/templates — the workspace's templates
// for its members: the new-document dialog's "This workspace" tab and the
// brand-kit tab. Each is a live link to a workspace document.
export default defineApiHandler({
  access: allow.workspace('member'),
  handler: async ({ event, wsId, role, workspaceAccess }) => {
    setHeader(event, 'cache-control', 'private, no-store')
    return {
      available: await brandKitAvailable(wsId),
      canManage: role === 'admin',
      templates: (await listWorkspaceTemplates(workspaceAccess)).map(t => ({
        id: t.id,
        name: t.name,
        description: t.description,
        docId: t.docId,
        docTitle: t.docTitle
      }))
    }
  }
})
