import { searchEverywhere } from '../../utils/explorer/folderActions'
import { documentSearchQuery } from '~~/shared/api/explorer'

// Quick search (Ctrl/Cmd+K and the explorer's "search everywhere"): titles
// and full text of the caller's personal documents, every workspace they are
// a member of (with a current single sign-on where that is enforced), and
// documents shared with them as a guest. Nothing else: a public document
// they once opened is not searchable by them.
export default defineApiHandler({
  access: allow.user(),
  query: documentSearchQuery,
  rateLimit: { namespace: 'doc-search', max: 60, windowMs: 60_000, key: 'user' },
  handler: async ({ self, query }) => searchEverywhere(self, query)
})
