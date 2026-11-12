import { listAbuseReportsForTriage, listNoticesForReports } from '../../repos/abuseReports'
import { listAbuseReportsQuery } from '~~/shared/api/legal'

// Admin queue: abuse reports for triage, filterable by status (default: open +
// acknowledged, the actionable queue). Joins to users for the reporter's name
// and email. Offset pagination capped at 100 per page.

const ALLOWED_STATUSES = ['open', 'acknowledged', 'actioned', 'dismissed'] as const

export default defineApiHandler({
  access: allow.admin(),
  query: listAbuseReportsQuery,
  handler: async ({ query, adminActor }) => {
    const statuses: Array<(typeof ALLOWED_STATUSES)[number]> = !query.status
      ? ['open', 'acknowledged']
      : query.status === 'all' ? [...ALLOWED_STATUSES] : [query.status]

    const limit = query.limit

    const rows = await listAbuseReportsForTriage(adminActor, statuses, limit)
    const notices = await listNoticesForReports(adminActor, rows.map(r => r.reportId))

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
