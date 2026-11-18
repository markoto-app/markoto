import { createFolderInScope } from '../../../../utils/explorer/folderActions'
import { createFolderBody } from '~~/shared/api/explorer'

// Create a folder in the workspace (admins and editors). Folders carry no
// permissions: every member sees them.
export default defineApiHandler({
  access: allow.workspace('editor'),
  body: createFolderBody,
  rateLimit: { namespace: 'folder-write', max: 120, windowMs: 60_000, key: 'user' },
  handler: async ({ event, user, workspaceAccess, wsId, body }) => {
    const folder = await createFolderInScope({ kind: 'workspace', workspaceId: wsId, scope: workspaceAccess }, { userId: user.id, ip: getClientIp(event) }, body.name, body.parentId ?? null)
    return { folder }
  }
})
