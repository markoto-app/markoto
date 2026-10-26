import { eq, sql } from 'drizzle-orm'
import { abuseReports } from '../../../db/schema'
import { useDatabase } from '../../../utils/database'
import { requireAdminUser } from '../../../utils/adminAccess'
import { appendAuditEvent } from '../../../repos/audit'
import {
  AUDIT_ABUSE_ACKNOWLEDGED,
  AUDIT_ABUSE_ACTIONED,
  AUDIT_ABUSE_DISMISSED
} from '../../../legal/auditActions'

// Admin status transitions for abuse reports. Allowed flows:
//   open → acknowledged   (we have eyes on it)
//   open → actioned       (we removed/restricted the content)
//   open → dismissed      (we reviewed and decided no action)
//   acknowledged → actioned / dismissed
//
// Backwards transitions (e.g. "actioned" → "open") are NOT allowed
// — a closed report is closed. If something turns out wrong on
// review, file a fresh report referencing the closed one in notes.
//
// Each transition stamps the actioning admin + timestamp + audit
// row with the appropriate action constant.

interface RequestBody {
  status: 'acknowledged' | 'actioned' | 'dismissed'
  notes?: string
}

const ACTION_AUDIT: Record<RequestBody['status'], string> = {
  acknowledged: AUDIT_ABUSE_ACKNOWLEDGED,
  actioned: AUDIT_ABUSE_ACTIONED,
  dismissed: AUDIT_ABUSE_DISMISSED
}

export default defineEventHandler(async (event) => {
  const admin = await requireAdminUser(event)
  const reportId = getRouterParam(event, 'reportId')
  if (!reportId) throw createError({ statusCode: 400, message: 'reportId required' })

  const body = await readBody<RequestBody>(event)
  if (!body || !['acknowledged', 'actioned', 'dismissed'].includes(body.status)) {
    throw createError({ statusCode: 400, message: 'Invalid status' })
  }

  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 5000) : null

  const db = useDatabase()
  // Re-read first so we have the existing notes + status for the
  // audit `before` payload AND to validate the transition.
  const existing = (await db
    .select()
    .from(abuseReports)
    .where(eq(abuseReports.reportId, reportId))
    .limit(1))[0]
  if (!existing) {
    throw createError({ statusCode: 404, message: 'Report not found' })
  }
  if (existing.status === 'actioned' || existing.status === 'dismissed') {
    throw createError({
      statusCode: 409,
      message: `Report is already ${existing.status}; cannot reopen.`,
      data: { code: 'abuse/already-closed' }
    })
  }

  const updates: Record<string, unknown> = {
    status: body.status,
    actionedBy: admin.userId,
    notes: notes ?? existing.notes
  }
  if (body.status === 'acknowledged') {
    updates.acknowledgedAt = sql`now()`
  } else if (body.status === 'actioned' || body.status === 'dismissed') {
    updates.actionedAt = sql`now()`
    // If the report skipped acknowledged-state and went straight
    // to actioned/dismissed, stamp the acknowledged time too —
    // ops will want to see "we saw this at..." regardless of
    // whether the admin paused at the acknowledged state.
    if (existing.acknowledgedAt === null) {
      updates.acknowledgedAt = sql`now()`
    }
  }

  await db
    .update(abuseReports)
    .set(updates)
    .where(eq(abuseReports.reportId, reportId))

  const ip = getClientIp(event)

  await appendAuditEvent({
    actorUserId: admin.userId,
    actorIp: ip,
    scope: 'system',
    scopeId: reportId,
    action: ACTION_AUDIT[body.status],
    before: {
      status: existing.status,
      notes: existing.notes
    },
    after: {
      status: body.status,
      notes: notes ?? existing.notes
    },
    metadata: {
      reportId,
      category: existing.category,
      docId: existing.docId
    }
  })

  return { ok: true }
})
