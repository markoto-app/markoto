import { getWorkspaceExplorerVersion } from '../../../repos/workspaces'

// The workspace's explorer change counter: open explorers poll it (about
// every 15 s while visible, and on focus) and refetch their folder and tree
// when it moved. One indexed read.
export default defineApiHandler({
  access: allow.workspace('member'),
  handler: async ({ workspaceAccess }) => ({ version: await getWorkspaceExplorerVersion(workspaceAccess) })
})
