import { listDocsPage } from '../../../utils/explorer/docLists'
import { docListQuery } from '~~/shared/api/explorer'

// A page of the workspace's documents for the explorer: one folder (or the
// root, or all), sorted, filtered by owner, or a ranked search with `q`.
// Any member; the access mode of a document plays no part inside its
// workspace (members see every document).
export default defineApiHandler({
  access: allow.workspace('member', { ssoHint: true }),
  query: docListQuery,
  handler: async ({ self, workspaceAccess, query }) => listDocsPage(self, workspaceAccess, query)
})
