import { aliasedTable, and, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import { abuseReports, moderationNotices, users } from '../db/schema'
import { useDatabase } from '../db/client'
import type { AdminActor, SystemActor, UserScope } from './proofs'

// DSA Art.16 notices (`abuse_reports`): filed by anyone, triaged by instance
// admins. The admin reads and transitions take the admin's proof; the
// transition records that admin as `actioned_by`.

export type AbuseReportRow = typeof abuseReports.$inferSelect
export type AbuseReportStatus = AbuseReportRow['status']

export type NewAbuseReport = Omit<typeof abuseReports.$inferInsert, 'reporterUserId' | 'status'>

/** File a report; `reporter` is the signed-in reporter, null for an anonymous one. */
export async function insertAbuseReport(reporter: UserScope | null, report: NewAbuseReport): Promise<void> {
  await useDatabase().insert(abuseReports).values({ ...report, reporterUserId: reporter?.userId ?? null, status: 'open' })
}

/** The triage queue: reports in `statuses`, newest first, with reporter and actioning admin joined. */
export async function listAbuseReportsForTriage(_by: AdminActor, statuses: readonly AbuseReportStatus[], limit: number) {
  // Two joins to `users` (reporter, actioning admin), hence the aliases.
  const reporter = aliasedTable(users, 'reporter')
  const actioner = aliasedTable(users, 'actioner')
  return useDatabase()
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
    .where(inArray(abuseReports.status, [...statuses]))
    .orderBy(desc(abuseReports.createdAt))
    .limit(limit)
}

/** Every notice produced for these reports (receipt, decision, statement of reasons — delivered or not). */
export async function listNoticesForReports(_by: AdminActor, reportIds: readonly string[]) {
  if (reportIds.length === 0) return []
  return useDatabase()
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
    .where(inArray(moderationNotices.reportId, [...reportIds]))
    .orderBy(moderationNotices.createdAt)
}

export async function getAbuseReport(_by: AdminActor, reportId: string): Promise<AbuseReportRow | null> {
  return (await useDatabase().select().from(abuseReports).where(eq(abuseReports.reportId, reportId)).limit(1))[0] ?? null
}

/**
 * Claim a status transition atomically: only while the report still has
 * `from` (two moderators can't both act — and both email — on one report).
 * The proof's admin is recorded as `actioned_by`. False when someone else
 * moved it first.
 */
export async function claimAbuseReportTransition(
  admin: AdminActor,
  reportId: string,
  from: { status: AbuseReportStatus, acknowledgedAt: Date | null, notes: string | null },
  to: { status: 'acknowledged' | 'actioned' | 'dismissed', notes: string | null, decision: { action: NonNullable<AbuseReportRow['decisionAction']>, rule: string | null, explanation: string } | null }
): Promise<boolean> {
  const claimed = await useDatabase()
    .update(abuseReports)
    .set({
      status: to.status,
      actionedBy: admin.userId,
      notes: to.notes ?? from.notes,
      ...(to.status === 'acknowledged'
        ? { acknowledgedAt: sql`now()` }
        : {
            actionedAt: sql`now()`,
            // Skipped acknowledged → stamp it too ("we saw this at…").
            acknowledgedAt: from.acknowledgedAt ?? sql`now()`,
            decisionAction: to.decision?.action ?? null,
            decisionRule: to.decision?.rule ?? null,
            decisionExplanation: to.decision?.explanation ?? null
          })
    })
    .where(sql`${abuseReports.reportId} = ${reportId} AND ${abuseReports.status} = ${from.status}`)
    .returning({ reportId: abuseReports.reportId })
  return claimed.length > 0
}

/** Retention: reports closed (actioned / dismissed) before `cutoff`; their notices cascade. Returns how many. */
export async function deleteClosedAbuseReportsBefore(_by: SystemActor, cutoff: Date): Promise<number> {
  return (await useDatabase()
    .delete(abuseReports)
    .where(and(inArray(abuseReports.status, ['actioned', 'dismissed']), isNotNull(abuseReports.actionedAt), lt(abuseReports.actionedAt, cutoff)))
    .returning({ id: abuseReports.id })).length
}

/** Record a notice we produced for a report (receipt, decision, statement of reasons), delivered or not. */
export async function recordModerationNotice(_by: SystemActor, notice: typeof moderationNotices.$inferInsert): Promise<void> {
  await useDatabase().insert(moderationNotices).values(notice)
}
