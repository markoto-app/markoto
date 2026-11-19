import { folderDeletePreview } from '../../../utils/explorer/folderActions'
import { folderParams } from '~~/shared/api/explorer'

// What deleting the folder would remove (subfolders, documents) and how many
// of those documents the caller may not delete, for the confirmation dialog.
export default defineApiHandler({
  access: allow.user(),
  params: folderParams,
  handler: async ({ user, params }) => folderDeletePreview(user.id, params.folderId)
})
