import { appendAuditEvent } from '../../../../repos/audit'
import { deleteShare } from '../../../../repos/documentShares'
import { AUDIT_DOC_UNSHARED } from '../../../../legal/auditActions'
import { requireDocSharingAccess } from '../../../../utils/documents/documentSharing'
import { notifySyncKickUser } from '../../../../utils/documents/syncNotify'

// DELETE /api/docs/:docId/shares/:userId — stop sharing with a guest.
// Their open editor connection is closed; audited (`doc.unshared`).
export default defineEventHandler(async (event) => {
  const { userId: actorId, docId, workspaceId } = await requireDocSharingAccess(event)
  const guestId = Number(getRouterParam(event, 'userId'))
  if (!Number.isInteger(guestId) || guestId <= 0) throw createError({ statusCode: 400, message: 'Invalid user.' })
  if (!(await deleteShare(docId, guestId))) throw createError({ statusCode: 404, message: 'Not shared with this person.' })
  notifySyncKickUser(guestId, [docId])
  await appendAuditEvent({ actorUserId: actorId, actorIp: getClientIp(event), scope: 'doc', scopeId: docId, workspaceId, action: AUDIT_DOC_UNSHARED, metadata: { affectedUserId: guestId } })
  return { ok: true }
})
