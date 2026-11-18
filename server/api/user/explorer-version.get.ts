import { getUserExplorerVersion } from '../../repos/users'

// The change counter of the caller's personal documents and folders (see
// GET /api/workspaces/:wsId/version).
export default defineApiHandler({
  access: allow.user(),
  handler: async ({ self }) => ({ version: await getUserExplorerVersion(self) })
})
