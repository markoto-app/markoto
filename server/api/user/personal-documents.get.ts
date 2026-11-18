import { listDocsPage } from '../../utils/explorer/docLists'
import { docListQuery } from '~~/shared/api/explorer'

// A page of the caller's personal documents (owned, outside any workspace)
// for the explorer: a folder, the root, all, or a ranked search with `q`.
export default defineApiHandler({
  access: allow.user(),
  query: docListQuery,
  handler: async ({ self, query }) => listDocsPage(self, self, query)
})
