import { listSharesForDoc } from '../../../../repos/documentShares'
import { listWorkspaceGuests } from '../../../../utils/documents/documentSharing'

// GET /api/docs/:docId/shares — guests this document is shared with, and
// the workspace's guests to pick from. Admins + editors of the
// document's workspace (not its guests).
export default defineApiHandler({
  access: allow.doc('share-guests', { deny: 'share/not-allowed' }),
  handler: async ({ docId, doc }) => {
    // `share-guests` only admits workspace documents; checked again so the type narrows.
    if (!doc.workspaceId) throw apiError('share/not-allowed')
    const [shares, guests] = await Promise.all([listSharesForDoc(docId), listWorkspaceGuests(doc.workspaceId)])
    return { shares, guests }
  }
})
