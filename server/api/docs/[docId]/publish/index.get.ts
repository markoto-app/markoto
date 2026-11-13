import { publishView } from '../../../../utils/publish/access'
import { getPublishedPageSummary } from '../../../../repos/publishedPages'

// GET /api/docs/:docId/publish: is the document published as a web page,
// at which address, indexed or not. Owner + workspace admins.
export default defineApiHandler({
  access: allow.doc('manage', { deny: 'publish/not-allowed' }),
  handler: async ({ event, docAccess }) => publishView(event, await getPublishedPageSummary(docAccess))
})
