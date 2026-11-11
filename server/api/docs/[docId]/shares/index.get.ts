import { listSharesForDoc } from '../../../../repos/documentShares'
import { listWorkspaceGuests, requireDocSharingAccess } from '../../../../utils/documents/documentSharing'

// GET /api/docs/:docId/shares — guests this document is shared with, and
// the workspace's guests to pick from (WP11). Admins + editors of the
// document's workspace.
export default defineEventHandler(async (event) => {
  const { docId, workspaceId } = await requireDocSharingAccess(event)
  const [shares, guests] = await Promise.all([listSharesForDoc(docId), listWorkspaceGuests(workspaceId)])
  return { shares, guests }
})
