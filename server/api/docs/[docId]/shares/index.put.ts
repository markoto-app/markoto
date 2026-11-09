import { appendAuditEvent } from '../../../../repos/audit'
import { upsertShare } from '../../../../repos/documentShares'
import { AUDIT_DOC_SHARED } from '../../../../legal/auditActions'
import { requireDocSharingAccess, requireWorkspaceGuest } from '../../../../utils/documentSharing'
import { notifySyncKickUser } from '../../../../utils/syncNotify'

// PUT /api/docs/:docId/shares — {userId, access: 'view' | 'edit'}: share
// the document with a guest of its workspace, or change their access
// (WP11). Audited (`doc.shared`).
export default defineEventHandler(async (event) => {
  const { userId: actorId, docId, workspaceId } = await requireDocSharingAccess(event)
  const body = await readBody<{ userId?: unknown, access?: unknown }>(event)
  if (body?.access !== 'view' && body?.access !== 'edit') throw createError({ statusCode: 400, message: 'Access is view or edit.', data: { code: 'share/invalid' } })
  const guestId = await requireWorkspaceGuest(workspaceId, body.userId)
  const before = await upsertShare({ docId, userId: guestId, access: body.access, grantedByUserId: actorId })
  // Edit → view: their open editor holds a writable token; close it so
  // they reconnect read-only.
  if (before === 'edit' && body.access === 'view') notifySyncKickUser(guestId, [docId])
  if (before !== body.access) {
    await appendAuditEvent({
      actorUserId: actorId,
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
})
