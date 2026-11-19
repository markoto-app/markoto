import { folderTree } from '../../../../utils/explorer/docLists'

// The workspace's folder tree, flat (each row names its parent), with the
// number of documents filed directly in each folder. Any member sees it;
// guests have no role here and never see the workspace's folders.
export default defineApiHandler({
  access: allow.workspace('member', { ssoHint: true }),
  handler: async ({ workspaceAccess }) => ({ folders: await folderTree(workspaceAccess) })
})
