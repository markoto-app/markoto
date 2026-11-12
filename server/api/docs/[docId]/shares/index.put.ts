import { appendAuditEvent } from '../../../../repos/audit'
import { upsertShare } from '../../../../repos/documentShares'
import { AUDIT_DOC_SHARED } from '../../../../legal/auditActions'
import { requireWorkspaceGuest } from '../../../../utils/documents/documentSharing'
import { notifySyncKickUser } from '../../../../utils/documents/syncNotify'
import { assertNotModerationRestricted } from '../../../../utils/privacy/moderationRestriction'
import { getDoc } from '../../../../repos/documents'
import { upsertDocShareBody } from '~~/shared/api/sharing'

// PUT /api/docs/:docId/shares: {userId, access: 'view' | 'edit'}: share
// the document with a guest of its workspace, or change their access.
// Admins + editors of the workspace. Audited (`doc.shared`).
export default defineApiHandler({
  access: allow.doc('share-guests', { deny: 'share/not-allowed' }),
  body: upsertDocShareBody,
  invalidCode: 'share/invalid',
  handler: async ({ event, docId, doc, docAccess, body }) => {
    if (!doc.workspaceId) throw apiError('share/not-allowed')
    const workspaceId = doc.workspaceId
    // A share widens who can open the document: refused while restricted.
    assertNotModerationRestricted(await getDoc(docAccess))
    const guestId = await requireWorkspaceGuest(workspaceId, body.userId)
    const before = await upsertShare(docAccess, { userId: guestId, access: body.access })
    // Edit → view: their open editor holds a writable token; close it so
    // they reconnect read-only.
    if (before === 'edit' && body.access === 'view') notifySyncKickUser(guestId, [docId])
    if (before !== body.access) {
      await appendAuditEvent({
        by: docAccess,
        actorIp: getClientIp(event),
        scope: 'doc',
        scopeId: docId,
        workspaceId,
        action: AUDIT_DOC_SHARED,
        before: before ? { access: before } : null,
        after: { access: body.access },
        metadata: { affectedUserId: guestId }
      })
    }
    return { ok: true }
  }
})
