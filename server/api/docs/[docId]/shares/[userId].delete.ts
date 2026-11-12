import { appendAuditEvent } from '../../../../repos/audit'
import { deleteShare } from '../../../../repos/documentShares'
import { AUDIT_DOC_UNSHARED } from '../../../../legal/auditActions'
import { notifySyncKickUser } from '../../../../utils/documents/syncNotify'
import { deleteDocShareParams } from '~~/shared/api/sharing'

// DELETE /api/docs/:docId/shares/:userId — stop sharing with a guest.
// Admins + editors of the workspace. Their open editor connection is
// closed; audited (`doc.unshared`).
export default defineApiHandler({
  access: allow.doc('share-guests', { deny: 'share/not-allowed' }),
  params: deleteDocShareParams,
  invalidCode: 'share/invalid',
  handler: async ({ event, docId, doc, docAccess, params: { userId: guestId } }) => {
    if (!(await deleteShare(docAccess, guestId))) throw apiError('share/not-shared')
    notifySyncKickUser(guestId, [docId])
    await appendAuditEvent({ by: docAccess, actorIp: getClientIp(event), scope: 'doc', scopeId: docId, workspaceId: doc.workspaceId, action: AUDIT_DOC_UNSHARED, metadata: { affectedUserId: guestId } })
    return { ok: true }
  }
})
