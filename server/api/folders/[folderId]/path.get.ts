import { folderBreadcrumb } from '../../../utils/explorer/folderActions'
import { folderParams } from '~~/shared/api/explorer'

// The folder's ancestors, root first (breadcrumbs of a deep link). 404 for a
// folder the caller can't see, the same as for one that doesn't exist.
export default defineApiHandler({
  access: allow.user(),
  params: folderParams,
  handler: async ({ user, params }) => folderBreadcrumb(user.id, params.folderId)
})
