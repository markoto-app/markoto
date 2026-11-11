import { requireShareManager } from '../../../../utils/documents/shareSettings'
import { documentViews } from '../../../../repos/documentViews'
import { getDocWithActorRole } from '../../../../repos/documents'

// GET /api/docs/:docId/share-settings — share-link controls for the
// owner and workspace admins: expiry, view-only without download, and the
// opens of the last 30 days (only on a plan with the feature).
export default defineEventHandler(async (event) => {
  const { userId, docId, available } = await requireShareManager(event)
  const row = (await getDocWithActorRole(docId, userId))!
  setHeader(event, 'cache-control', 'private, no-store')
  return {
    available,
    expiresAt: row.shareExpiresAt?.toISOString() ?? null,
    noDownload: row.shareNoDownload,
    views: available ? await documentViews(docId, 30) : null
  }
})
