import { aliasedTable, desc, eq, inArray } from 'drizzle-orm'
import { abuseReports, users } from '../../db/schema'
import { useDatabase } from '../../utils/database'
import { requireAdminUser } from '../../utils/adminAccess'

// Admin queue: list abuse reports for triage. Filterable by status
// (default: open + acknowledged — the actionable queue).
//
// Joins to users so the caller sees the reporter's name + email
// without a second round-trip. Joining via the audit log would
// also work but the abuse_reports row doesn't carry the reporter
// id directly (we kept that pseudonymised); we look up via the
// audit row's actor_user_id at read time when needed.
//
// Pagination: simple offset-based, capped at 100 per page. The
// queue should never grow large enough to need cursor-based pagination
// — if it does, that's a separate ops-scale problem.

const ALLOWED_STATUSES = ['open', 'acknowledged', 'actioned', 'dismissed'] as const
type Status = (typeof ALLOWED_STATUSES)[number]

export default defineEventHandler(async (event) => {
  await requireAdminUser(event)

  const query = getQuery(event)
  const requestedStatus = query.status
  const statuses: Status[] = (() => {
    if (typeof requestedStatus !== 'string' || !requestedStatus) {
      return ['open', 'acknowledged']
    }
    if (requestedStatus === 'all') {
      return [...ALLOWED_STATUSES]
    }
    return ALLOWED_STATUSES.includes(requestedStatus as Status)
      ? [requestedStatus as Status]
      : ['open', 'acknowledged']
  })()

  const limit = Math.min(Number(query.limit ?? 50), 100)

  const db = useDatabase()
  // Two joins to `users`: one for the reporter (so the moderator
  // can see who reported + has a mailto: handle), one for the
  // actioning admin (when the report has been triaged). Aliased
  // because both joins target the same table.
  const reporter = aliasedTable(users, 'reporter')
  const actioner = aliasedTable(users, 'actioner')
  const rows = await db
    .select({
      reportId: abuseReports.reportId,
      docId: abuseReports.docId,
      category: abuseReports.category,
      body: abuseReports.body,
      status: abuseReports.status,
      notes: abuseReports.notes,
      createdAt: abuseReports.createdAt,
      acknowledgedAt: abuseReports.acknowledgedAt,
      actionedAt: abuseReports.actionedAt,
      reporterIpTruncated: abuseReports.reporterIpTruncated,
      reporterUserId: abuseReports.reporterUserId,
      reporterEmailSnapshot: abuseReports.reporterEmail,
      reporterName: reporter.name,
      reporterEmail: reporter.email,
      actionedBy: abuseReports.actionedBy,
      actionedByName: actioner.name,
      actionedByEmail: actioner.email
    })
    .from(abuseReports)
    .leftJoin(reporter, eq(reporter.id, abuseReports.reporterUserId))
    .leftJoin(actioner, eq(actioner.id, abuseReports.actionedBy))
    .where(inArray(abuseReports.status, statuses))
    .orderBy(desc(abuseReports.createdAt))
    .limit(limit)

  return rows.map(r => ({
    reportId: r.reportId,
    docId: r.docId,
    category: r.category,
    body: r.body,
    status: r.status,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
    acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
    actionedAt: r.actionedAt?.toISOString() ?? null,
    reporterIpTruncated: r.reporterIpTruncated,
    // Reporter — name + email come from the live join when the
    // user still exists, fallback to the email snapshot when the
    // user has since deleted their account (FK auto-nulled). Email
    // channel reports (no reporterUserId) won't surface here —
    // those go to the abuse@ inbox separately.
    reporter: r.reporterUserId === null && r.reporterEmailSnapshot === null
      ? null
      : {
          userId: r.reporterUserId,
          name: r.reporterName,
          email: r.reporterEmail ?? r.reporterEmailSnapshot,
          stillExists: r.reporterUserId !== null && r.reporterName !== null
        },
    actionedBy: r.actionedBy === null
      ? null
      : {
          userId: r.actionedBy,
          name: r.actionedByName,
          email: r.actionedByEmail
        }
  }))
})
