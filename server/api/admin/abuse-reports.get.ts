import { aliasedTable, desc, eq, inArray } from 'drizzle-orm'
import { abuseReports, moderationNotices, users } from '../../db/schema'
import { useDatabase } from '../../utils/platform/database'
import { listAbuseReportsQuery } from '~~/shared/api/legal'

// Admin queue: abuse reports for triage, filterable by status (default: open +
// acknowledged, the actionable queue). Joins to users for the reporter's name
// and email. Offset pagination capped at 100 per page.

const ALLOWED_STATUSES = ['open', 'acknowledged', 'actioned', 'dismissed'] as const

export default defineApiHandler({
  access: allow.admin(),
  query: listAbuseReportsQuery,
  handler: async ({ query }) => {
    const statuses: Array<(typeof ALLOWED_STATUSES)[number]> = !query.status
      ? ['open', 'acknowledged']
      : query.status === 'all' ? [...ALLOWED_STATUSES] : [query.status]

    const limit = Math.min(query.limit ?? 50, 100)

    const db = useDatabase()
    // Two joins to `users` (reporter, actioning admin), hence the aliases.
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
        reporterNameSnapshot: abuseReports.reporterName,
        contentUrl: abuseReports.contentUrl,
        goodFaithConfirmedAt: abuseReports.goodFaithConfirmedAt,
        decisionAction: abuseReports.decisionAction,
        decisionRule: abuseReports.decisionRule,
        decisionExplanation: abuseReports.decisionExplanation,
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

    // Every notice we produced for these reports (receipt, decision,
    // statement of reasons — incl. the ones we could not deliver).
    const notices = rows.length === 0
      ? []
      : await db
          .select({
            reportId: moderationNotices.reportId,
            kind: moderationNotices.kind,
            recipientRole: moderationNotices.recipientRole,
            status: moderationNotices.status,
            subject: moderationNotices.subject,
            body: moderationNotices.body,
            createdAt: moderationNotices.createdAt
          })
          .from(moderationNotices)
          .where(inArray(moderationNotices.reportId, rows.map(r => r.reportId)))
          .orderBy(moderationNotices.createdAt)

    return rows.map(r => ({
      reportId: r.reportId,
      docId: r.docId,
      contentUrl: r.contentUrl,
      goodFaithConfirmedAt: r.goodFaithConfirmedAt?.toISOString() ?? null,
      decision: r.decisionAction === null
        ? null
        : { action: r.decisionAction, rule: r.decisionRule, explanation: r.decisionExplanation },
      notices: notices
        .filter(n => n.reportId === r.reportId)
        .map(n => ({ kind: n.kind, recipientRole: n.recipientRole, status: n.status, subject: n.subject, body: n.body, createdAt: n.createdAt.toISOString() })),
      category: r.category,
      body: r.body,
      status: r.status,
      notes: r.notes,
      createdAt: r.createdAt.toISOString(),
      acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
      actionedAt: r.actionedAt?.toISOString() ?? null,
      reporterIpTruncated: r.reporterIpTruncated,
      // Name + email come from the live join, falling back to the email snapshot
      // when the reporter has deleted their account (FK auto-nulled). Anonymous
      // form reports carry only the name + email typed; `signedIn` tells them
      // apart. Email-channel reports go to the abuse@ inbox, not here.
      reporter: r.reporterUserId === null && r.reporterEmailSnapshot === null && r.reporterNameSnapshot === null
        ? null
        : {
            userId: r.reporterUserId,
            name: r.reporterName ?? r.reporterNameSnapshot,
            email: r.reporterEmailSnapshot ?? r.reporterEmail,
            stillExists: r.reporterUserId !== null && r.reporterName !== null,
            signedIn: r.reporterUserId !== null
          },
      actionedBy: r.actionedBy === null
        ? null
        : {
            userId: r.actionedBy,
            name: r.actionedByName,
            email: r.actionedByEmail
          }
    }))
  }
})
