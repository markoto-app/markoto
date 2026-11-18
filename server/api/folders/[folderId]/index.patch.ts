import { updateFolder } from '../../../utils/explorer/folderActions'
import { folderParams, updateFolderBody } from '~~/shared/api/explorer'

// Rename and / or move a folder (workspace admins and editors; the owner for
// a personal folder). A folder of another workspace is not found.
export default defineApiHandler({
  access: allow.user(),
  params: folderParams,
  body: updateFolderBody,
  rateLimit: { namespace: 'folder-write', max: 120, windowMs: 60_000, key: 'user' },
  handler: async ({ event, user, params, body }) => {
    const folder = await updateFolder({ userId: user.id, ip: getClientIp(event) }, params.folderId, body)
    return { folder }
  }
})
