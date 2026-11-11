import { requirePublishManager, publishView } from '../../../../utils/publish/access'
import { getPublishedPageSummary } from '../../../../repos/publishedPages'

// GET /api/docs/:docId/publish — is the document published as a web page,
// at which address, indexed or not. Owner + workspace admins.
export default defineEventHandler(async (event) => {
  const { docId } = await requirePublishManager(event)
  return publishView(event, await getPublishedPageSummary(docId))
})
