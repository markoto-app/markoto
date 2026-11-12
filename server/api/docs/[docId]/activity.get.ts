import { hasActivityBefore, listRecentActivity } from '../../../repos/activity'
import { HISTORY_LIMITED_HEADER, capsFor, historyCutoff, resolveDocPlanFor } from '../../../utils/billing/entitlements'

// Activity log is a view-level read; access rules mirror file access
// (`decideActivityAccess`):
//   - open-edit / open-view: public.
//   - private / password-protected: owner, workspace member, or holder of a
//     valid doc-scoped JWT (anon users who verified a password).

export default defineApiHandler({
  access: allow.doc('activity', { anonymous: true, jwt: true }),
  handler: async ({ event, doc, docAccess }) => {
    // The plan may limit how far back history goes (`historyDays`). Older rows
    // stay stored; the header tells the UI some are hidden.
    const plan = await resolveDocPlanFor({ ownerId: doc.ownerId, workspaceId: doc.workspaceId })
    const cutoff = historyCutoff(plan)
    if (cutoff && await hasActivityBefore(docAccess, cutoff)) {
      setResponseHeader(event, HISTORY_LIMITED_HEADER, String(capsFor(plan).historyDays))
    }
    return listRecentActivity(docAccess, 50, cutoff)
  }
})
