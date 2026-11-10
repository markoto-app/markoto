import { brandKitAvailable, requireBrandKitMember } from '../../../../utils/brandKit/access'
import { listWorkspaceTemplates } from '../../../../repos/workspaceTemplates'

// GET /api/workspaces/:wsId/templates — the workspace's templates (WP10c)
// for its members: the new-document dialog's "This workspace" tab and the
// brand-kit tab. Each is a live link to a workspace document.
export default defineEventHandler(async (event) => {
  const { wsId, role } = await requireBrandKitMember(event)
  setHeader(event, 'cache-control', 'private, no-store')
  return {
    available: await brandKitAvailable(wsId),
    canManage: role === 'admin',
    templates: (await listWorkspaceTemplates(wsId)).map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      docId: t.docId,
      docTitle: t.docTitle
    }))
  }
})
