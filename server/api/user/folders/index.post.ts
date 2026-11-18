import { createFolderInScope } from '../../../utils/explorer/folderActions'
import { createFolderBody } from '~~/shared/api/explorer'

// Create a personal folder.
export default defineApiHandler({
  access: allow.user(),
  body: createFolderBody,
  rateLimit: { namespace: 'folder-write', max: 120, windowMs: 60_000, key: 'user' },
  handler: async ({ event, user, self, body }) => {
    const folder = await createFolderInScope({ kind: 'personal', workspaceId: null, scope: self }, { userId: user.id, ip: getClientIp(event) }, body.name, body.parentId ?? null)
    return { folder }
  }
})
