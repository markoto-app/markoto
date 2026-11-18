import { deleteFolderTree } from '../../../utils/explorer/bulkActions'
import { folderParams } from '~~/shared/api/explorer'

// Delete a folder, its subfolders and every document filed below them, each
// through the normal document delete (storage, history, shares, published
// pages; audited one by one). Refused as a whole unless the caller may
// delete every one of those documents (`folder/delete-blocked` with the
// count). The explorer asks first, naming the counts
// (`GET /api/folders/:folderId/delete-preview`).
export default defineApiHandler({
  access: allow.user(),
  params: folderParams,
  rateLimit: { namespace: 'folder-delete', max: 20, windowMs: 60_000, key: 'user' },
  handler: async ({ event, user, params }) => {
    const deleted = await deleteFolderTree({ userId: user.id, ip: getClientIp(event) }, params.folderId)
    return { success: true, ...deleted }
  }
})
