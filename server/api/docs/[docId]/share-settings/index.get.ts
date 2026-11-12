import { documentViews } from '../../../../repos/documentViews'
import { planHasFeature, resolveDocPlanFor } from '../../../../utils/billing/entitlements'

// GET /api/docs/:docId/share-settings — share-link controls for the
// owner and workspace admins: expiry, view-only without download, and the
// opens of the last 30 days (only on a plan with the feature).
export default defineApiHandler({
  access: allow.doc('manage', { deny: 'share/not-allowed' }),
  handler: async ({ event, doc, docAccess }) => {
    // Reading the settings is free on every plan (they can be cleared after
    // a downgrade); `available` tells the dialog whether new ones can be set.
    const available = planHasFeature(await resolveDocPlanFor(doc), 'shareControls')
    setHeader(event, 'cache-control', 'private, no-store')
    return {
      available,
      expiresAt: doc.shareExpiresAt?.toISOString() ?? null,
      noDownload: doc.shareNoDownload,
      views: available ? await documentViews(docAccess, 30) : null
    }
  }
})
