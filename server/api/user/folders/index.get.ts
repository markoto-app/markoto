import { folderTree } from '../../../utils/explorer/docLists'

// The caller's personal folder tree (documents outside any workspace).
export default defineApiHandler({
  access: allow.user(),
  handler: async ({ self }) => ({ folders: await folderTree(self) })
})
