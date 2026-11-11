import { requireAdminUser } from '../../../../utils/auth/adminAccess'
import { getModerationRestriction, setModerationRestriction } from '../../../../repos/documents'
import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_DOC_MODERATION_RESTRICTION_LIFTED } from '../../../../legal/auditActions'

// DELETE /api/admin/documents/:docId/moderation-restriction {note}: lifts the
// restriction an `access_restricted` moderation decision put on a document
// (e.g. after an appeal). Platform admins only. The document stays private.
// Copies made while restricted keep their own restriction, each lifted
// separately after review.

const NOTE_MAX = 2000

export default defineEventHandler(async (event) => {
  const admin = await requireAdminUser(event)
  const docId = requireDocId(event)
  const body = await readBody<{ note?: unknown }>(event).catch(() => null)
  const note = typeof body?.note === 'string' ? body.note.trim() : ''
  if (note.length < 1 || note.length > NOTE_MAX) {
    throw createError({ statusCode: 400, message: `Say why the restriction is lifted (1–${NOTE_MAX} characters).`, data: { code: 'moderation/note-required' } })
  }
  const restriction = await getModerationRestriction(docId)
  if (!restriction) throw createError({ statusCode: 404, message: 'This document is not restricted.', data: { code: 'moderation/not-restricted' } })

  await setModerationRestriction(docId, null)
  await appendAuditEvent({
    actorUserId: admin.userId,
    actorIp: getClientIp(event),
    scope: 'doc',
    scopeId: docId,
    action: AUDIT_DOC_MODERATION_RESTRICTION_LIFTED,
    before: { restrictedAt: restriction.restrictedAt.toISOString() },
    after: null,
    metadata: { reportId: restriction.reportId ?? '', note }
  })
  return { ok: true }
})
