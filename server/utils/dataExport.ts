import { zipSync, strToU8 } from 'fflate'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import * as Sentry from '@sentry/nuxt'
import {
  abuseReports,
  activityLog,
  aiSessionMessages,
  aiSessions,
  auditLog,
  consentLog,
  documentComments,
  documentShares,
  documents,
  moderationNotices,
  ssoConnections,
  themes,
  userIdentities,
  users,
  workspaceBrandAssets,
  workspaceMembers,
  workspaces
} from '../db/schema'
import { useDatabase } from './database'
import { reconstructTextAtYjsId } from './historyReplay'
import { useStripeClient } from './stripeClient'
import { isBillingEnabled } from './billingMode'
import { listWaitlistSignupsForUser } from '../repos/waitlist'
import { listAiProviders } from '../repos/aiProviders'
import { listAiSessionProvenanceForUser } from '../repos/aiSessionProvenance'
import { listInvitesForExport } from '../repos/workspaceInvites'
import { normaliseInviteEmail } from './workspaceInvites'
import { listGrants } from '../repos/aiCreditGrants'
import { listSubscriptionsByBillingAdmin } from '../repos/workspaceSubscriptions'
import { listPublishedPagesForOwner } from '../repos/publishedPages'
import { listCustomDomainsForUser } from '../repos/customDomains'

// GDPR Article 15 + 20 export builder. Produces a self-describing
// ZIP archive containing every piece of personal data we hold for
// the user — in machine-readable formats (JSON, NDJSON, Markdown).
//
// **No side effects.** This module is purely "read DB → bytes". The
// worker (`dataExportWorker.ts`) is the side-effecting wrapper that
// uploads the result to S3 and updates the job row.
//
// **Layout** of the produced ZIP:
//
//   README.txt
//   profile.json
//   documents/{docId}.md            ← markdown, reconstructed from Y.js
//   documents/{docId}.meta.json
//   comments.ndjson                 ← every comment authored by the user
//   workspace_memberships.json
//   workspace_invites.json          ← open invitations to you + sent by you
//   themes.json                     ← saved themes
//   ai/sessions.ndjson
//   ai/messages.ndjson              ← prompt + tool-call history
//   ai/usage.ndjson                 ← per-period interaction counter
//   ai/providers.json               ← BYOK provider configs (never the key)
//   activity.ndjson                 ← rows where user_id = $userId
//   audit.ndjson                    ← rows scoped to or by the user
//   consent.ndjson
//   waitlist.ndjson                 ← paid-plans waitlist sign-ups linked to the account
//   abuse_reports.ndjson            ← reports the user filed while signed in + notices sent to them
//   moderation_notices.ndjson       ← statements of reasons the user got as a document owner
//   billing/invoices.ndjson         ← Stripe invoice history (if any)
//   billing/customer.json           ← Stripe customer record (if any)
//
// Where a file would be empty (e.g. no comments authored), we still
// emit it so the layout is predictable for any tool the user writes
// against the format.

const ZIP_README = `markoto data export

This archive contains every piece of personal data markoto holds
about your account. It is produced under your right of access
(GDPR Article 15) and right to data portability (Article 20).

Contents:

  README.txt             this file
  profile.json           your account row (no password hash, no secrets)
  documents/             one Markdown file + one .meta.json per document
                         you own. Markdown is reconstructed from the
                         Y.js history of the doc; if the document has
                         no edits yet, the .md file is empty.
  comments.ndjson        every comment you authored, one JSON object per
                         line (NDJSON format).
  workspace_memberships.json  workspaces you are a member of, with role
                         and join date.
  workspace_invites.json  open workspace invitations addressed to your
                         email ("received") and ones you sent
                         ("sent": the address you typed, role, dates).
  themes.json            saved themes you've created.
  sso_identities.json    workspace identity providers (single sign-on)
                         your account is linked to.
  document_shares.json   documents shared with you as a workspace guest
                         ("received") and ones you shared with guests
                         ("granted"), with view / edit access.
  brand_assets.json      fonts and logos you uploaded to a workspace's
                         brand kit (the files stay with the workspace).
  published_pages.json   your documents published as web pages: address,
                         indexing, when (the page is your document's text).
  custom_domains.json    your custom domains, their check status and the
                         page each shows.
  ai/sessions.ndjson     AI sessions you initiated.
  ai/messages.ndjson     AI prompt + tool-call history (NDJSON).
  ai/edit-provenance.ndjson  which AI sessions you started on which
                         document, and whether their edits count as
                         your own text for the AI's safety checks.
  ai/usage.ndjson        per-billing-period AI interaction counters.
  ai/providers.json      your own AI provider settings (provider URL,
                         model, last verification). API keys are never
                         exported.
  activity.ndjson        activity-log rows attributed to you.
  audit.ndjson           audit-log rows actioned by you OR scoped to
                         your user id.
  consent.ndjson         every consent decision you have made.
  waitlist.ndjson        your paid-plans waitlist sign-up, if you joined
                         it while signed in (email, language, consent
                         version, sign-up + confirmation dates).
  abuse_reports.ndjson   reports you filed while signed in: what you
                         reported and wrote, your contact details,
                         the status, our decision and every notice we
                         sent you about it (confirmation, decision).
  moderation_notices.ndjson  statements of reasons we sent you when we
                         removed or restricted one of your documents.
  billing/customer.json  your Stripe customer record (if billing was
                         set up).
  billing/invoices.ndjson  your Stripe invoice history (if any).
  billing/workspace_subscriptions.json  Team / Business subscriptions of
                         workspaces you manage as billing admin (plan,
                         seats, status, currency, dates).
  billing/ai_credits.json  AI credits you bought for yourself (pack,
                         credit, what's left, amount paid, expiry).

If a section is empty, the file still exists but contains zero rows.
`

export interface BuildExportZipResult {
  bytes: Uint8Array
  // Counts for the worker's row update + audit log. Optional — the
  // worker only needs the bytes; counts are nice for telemetry.
  counts: {
    documents: number
    comments: number
    workspaceMemberships: number
    workspaceInvites: number
    themes: number
    aiSessions: number
    aiSessionMessages: number
    activityLogRows: number
    auditLogRows: number
    consentLogRows: number
    waitlistSignups: number
    abuseReports: number
    moderationNotices: number
    aiProviders: number
    invoices: number
    workspaceSubscriptions: number
  }
}

/**
 * Build the export ZIP for `userId`. Throws if the user does not
 * exist; the worker treats that as a fatal job error.
 *
 * The ZIP is built in-memory via `fflate.zipSync`. For our scale
 * (typical user has tens of docs, hundreds of comments, thousands
 * of activity rows) this completes in well under a second and the
 * peak buffer is sub-MB. If any individual user's export grows to
 * tens of MB later, the worker can switch to a streaming PUT —
 * the layout doesn't change.
 */
export async function buildExportZip(userId: number): Promise<BuildExportZipResult> {
  const db = useDatabase()
  const userRow = (await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1))[0]
  if (!userRow) throw new Error(`buildExportZip: user ${userId} not found`)

  const entries: Record<string, Uint8Array> = {}
  entries['README.txt'] = strToU8(ZIP_README)
  entries['profile.json'] = strToU8(JSON.stringify(buildProfileEntry(userRow), null, 2))

  const documentsCount = await addOwnedDocumentsEntries(entries, db, userId)
  const commentsCount = await addCommentsEntry(entries, db, userId)
  const membershipsCount = await addWorkspaceMembershipsEntry(entries, db, userId)
  const invitesCount = await addWorkspaceInvitesEntry(entries, userId, userRow.email)
  const themesCount = await addThemesEntry(entries, db, userId)
  const { sessionsCount, messagesCount } = await addAiEntries(entries, db, userId)
  // Phase 6: ai_usage_period table dropped (LiteLLM owns spend state).
  // No usage history to export — LiteLLM's spend logs are operator-
  // facing only. If a user requests historical AI usage in the future,
  // re-add via a separate `/spend/logs` proxy.
  const activityCount = await addActivityLogEntry(entries, db, userId)
  const auditCount = await addAuditLogEntry(entries, db, userId)
  const consentCount = await addConsentLogEntry(entries, db, userId)
  const waitlistCount = await addWaitlistEntry(entries, userId)
  const abuseReportsCount = await addAbuseReportsEntry(entries, db, userId)
  const ownerNoticesCount = await addOwnerNoticesEntry(entries, db, userId)
  const aiProvidersCount = await addAiProvidersEntry(entries, userId)
  const invoicesCount = await addBillingEntries(entries, userRow.stripeCustomerId)
  const workspaceSubscriptionsCount = await addWorkspaceSubscriptionsEntry(entries, userId)
  await addCreditGrantsEntry(entries, userId)
  await addSsoIdentitiesEntry(entries, userId)
  await addDocumentSharesEntry(entries, userId)
  await addBrandAssetsEntry(entries, userId)
  await addPublishingEntries(entries, userId)

  return {
    bytes: zipSync(entries, { level: 6 }),
    counts: {
      documents: documentsCount,
      comments: commentsCount,
      workspaceMemberships: membershipsCount,
      workspaceInvites: invitesCount,
      themes: themesCount,
      aiSessions: sessionsCount,
      aiSessionMessages: messagesCount,
      activityLogRows: activityCount,
      auditLogRows: auditCount,
      consentLogRows: consentCount,
      waitlistSignups: waitlistCount,
      abuseReports: abuseReportsCount,
      moderationNotices: ownerNoticesCount,
      aiProviders: aiProvidersCount,
      invoices: invoicesCount,
      workspaceSubscriptions: workspaceSubscriptionsCount
    }
  }
}

type Db = ReturnType<typeof useDatabase>
type Entries = Record<string, Uint8Array>

/**
 * Profile projection. `users` doesn't store password hashes (we use
 * OAuth) but we still defensively project to the columns we want
 * surfaced, so a future column addition doesn't accidentally leak.
 */
function buildProfileEntry(userRow: typeof users.$inferSelect) {
  return {
    id: userRow.id,
    name: userRow.name,
    email: userRow.email,
    login: userRow.login,
    githubLinked: userRow.githubId !== null,
    googleLinked: userRow.googleId !== null,
    // Generic OIDC (WP7b): the issuer is the instance operator's own IdP;
    // the subject is an opaque identifier, kept out like the GitHub/Google ids.
    oidcLinked: userRow.oidcSubject !== null,
    oidcIssuer: userRow.oidcIssuer,
    plan: userRow.plan,
    planValidUntil: userRow.planValidUntil?.toISOString() ?? null,
    billingCurrency: userRow.billingCurrency,
    locale: userRow.locale,
    ageConfirmedAt: userRow.ageConfirmedAt?.toISOString() ?? null,
    deletionRequestedAt: userRow.deletionRequestedAt?.toISOString() ?? null,
    deletionGraceUntil: userRow.deletionGraceUntil?.toISOString() ?? null,
    privacyVersionAccepted: userRow.privacyVersionAccepted,
    privacyVersionAcceptedLocale: userRow.privacyVersionAcceptedLocale,
    tosVersionAccepted: userRow.tosVersionAccepted,
    tosVersionAcceptedLocale: userRow.tosVersionAcceptedLocale,
    dpaVersionAccepted: userRow.dpaVersionAccepted,
    dpaVersionAcceptedLocale: userRow.dpaVersionAcceptedLocale,
    createdAt: userRow.createdAt.toISOString()
  }
}

/**
 * y-postgresql creates `yjs_documents` lazily on the first write from
 * the sync server. In environments where the sync server hasn't run
 * (CI repos tests, fresh dev DB) the table doesn't exist yet — probe
 * `pg_class` so the export degrades gracefully to "no history; empty
 * markdown" instead of crashing.
 */
async function checkYjsTableExists(db: Db): Promise<boolean> {
  const row = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_class WHERE relname = 'yjs_documents' AND relkind = 'r'
    ) AS exists
  `)
  return row.rows?.[0]?.exists === true
}

/** Reconstruct a single doc's markdown via y-postgresql, with Sentry-reported error fallback so one failed doc doesn't sink the whole export. */
async function reconstructDocMarkdown(db: Db, docId: string, yjsTableExists: boolean): Promise<string> {
  let maxId: number | null = null
  if (yjsTableExists) {
    const latestYjs = await db.execute<{ max_id: number | null }>(sql`
      SELECT MAX(id)::int AS max_id FROM yjs_documents
      WHERE docname = ${docId} AND version = 'v1'
    `)
    maxId = latestYjs.rows?.[0]?.max_id ?? null
  }
  try {
    return await reconstructTextAtYjsId(docId, maxId)
  } catch (e) {
    Sentry.captureException(e, {
      tags: { component: 'dataExport', event: 'reconstruct_failed', docId }
    })
    return `[markoto] Document content could not be reconstructed at export time. Error: ${e instanceof Error ? e.message : String(e)}`
  }
}

async function addOwnedDocumentsEntries(entries: Entries, db: Db, userId: number): Promise<number> {
  const yjsTableExists = await checkYjsTableExists(db)
  const ownedDocs = await db
    .select()
    .from(documents)
    .where(eq(documents.ownerId, userId))
  for (const doc of ownedDocs) {
    const markdown = await reconstructDocMarkdown(db, doc.docId, yjsTableExists)
    entries[`documents/${doc.docId}.md`] = strToU8(markdown)
    entries[`documents/${doc.docId}.meta.json`] = strToU8(JSON.stringify({
      docId: doc.docId,
      title: doc.title,
      accessMode: doc.accessMode,
      workspaceId: doc.workspaceId,
      description: doc.description,
      audience: doc.audience,
      language: doc.language,
      templateId: doc.templateId,
      sizeBytes: doc.sizeBytes,
      wordCount: doc.wordCount,
      theme: doc.theme,
      createdAt: doc.createdAt.toISOString(),
      lastActive: doc.lastActive.toISOString()
    }, null, 2))
  }
  return ownedDocs.length
}

async function addCommentsEntry(entries: Entries, db: Db, userId: number): Promise<number> {
  const comments = await db
    .select()
    .from(documentComments)
    .where(eq(documentComments.authorId, userId))
    .orderBy(asc(documentComments.createdAtMs))
  entries['comments.ndjson'] = strToU8(toNdjson(comments.map(c => ({
    docId: c.docId,
    entryId: c.entryId,
    parentCommentId: c.parentCommentId,
    body: c.body,
    createdAtMs: c.createdAtMs.toISOString(),
    updatedAtMs: c.updatedAtMs.toISOString(),
    resolved: c.resolved
  }))))
  return comments.length
}

async function addWorkspaceMembershipsEntry(entries: Entries, db: Db, userId: number): Promise<number> {
  const memberships = await db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.joinedAt,
      workspaceName: workspaces.name
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.workspaceId, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaceMembers.joinedAt))
  entries['workspace_memberships.json'] = strToU8(JSON.stringify(
    memberships.map(m => ({
      workspaceId: m.workspaceId,
      workspaceName: m.workspaceName,
      role: m.role,
      joinedAt: m.joinedAt.toISOString()
    })),
    null, 2
  ))
  return memberships.length
}

async function addThemesEntry(entries: Entries, db: Db, userId: number): Promise<number> {
  const themesRows = await db
    .select()
    .from(themes)
    .where(eq(themes.userId, userId))
    .orderBy(asc(themes.createdAt))
  entries['themes.json'] = strToU8(JSON.stringify(
    themesRows.map(t => ({
      themeId: t.themeId,
      name: t.name,
      description: t.description,
      theme: t.theme,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString()
    })),
    null, 2
  ))
  return themesRows.length
}

async function addAiEntries(entries: Entries, db: Db, userId: number): Promise<{ sessionsCount: number, messagesCount: number }> {
  const sessionsRows = await db
    .select()
    .from(aiSessions)
    .where(eq(aiSessions.initiatorUserId, userId))
    .orderBy(asc(aiSessions.startedAt))
  entries['ai/sessions.ndjson'] = strToU8(toNdjson(sessionsRows.map(s => ({
    sessionId: s.sessionId,
    docId: s.docId,
    initiatorName: s.initiatorName,
    initiatorColor: s.initiatorColor,
    startedAt: s.startedAt.toISOString()
  }))))

  const aiMessagesRows = await db
    .select()
    .from(aiSessionMessages)
    .where(eq(aiSessionMessages.userId, userId))
    .orderBy(asc(aiSessionMessages.createdAt))
  entries['ai/messages.ndjson'] = strToU8(toNdjson(aiMessagesRows.map(m => ({
    docId: m.docId,
    sessionId: m.sessionId,
    kind: m.kind,
    body: m.body,
    createdAt: m.createdAt.toISOString()
  }))))

  const provenanceRows = await listAiSessionProvenanceForUser(userId)
  entries['ai/edit-provenance.ndjson'] = strToU8(toNdjson(provenanceRows.map(p => ({
    sessionId: p.sessionId,
    docId: p.docId,
    countsAsYourOwnText: p.clean,
    createdAt: p.createdAt.toISOString()
  }))))

  return { sessionsCount: sessionsRows.length, messagesCount: aiMessagesRows.length }
}

async function addActivityLogEntry(entries: Entries, db: Db, userId: number): Promise<number> {
  const activityRows = await db
    .select()
    .from(activityLog)
    .where(eq(activityLog.userId, userId))
    .orderBy(asc(activityLog.createdAt))
  entries['activity.ndjson'] = strToU8(toNdjson(activityRows.map(a => ({
    docId: a.docId,
    userName: a.userName,
    action: a.action,
    wordCount: a.wordCount,
    linesAdded: a.linesAdded,
    linesRemoved: a.linesRemoved,
    metadata: a.metadata,
    createdAt: a.createdAt.toISOString()
  }))))
  return activityRows.length
}

/**
 * Audit-log rows actioned BY the user OR scoped to them. The user
 * has a right of access to data ABOUT them — that includes audit
 * entries our system wrote where they were the actor or where the
 * audited entity was them (e.g. `account.delete_requested` with
 * `scope_id = String(userId)`).
 */
async function addAuditLogEntry(entries: Entries, db: Db, userId: number): Promise<number> {
  const auditRows = await db
    .select()
    .from(auditLog)
    .where(and(
      sql`(${auditLog.actorUserId} = ${userId} OR (${auditLog.scope} = 'user' AND ${auditLog.scopeId} = ${String(userId)}))`
    ))
    .orderBy(asc(auditLog.ts))
  entries['audit.ndjson'] = strToU8(toNdjson(auditRows.map(r => ({
    ts: r.ts.toISOString(),
    scope: r.scope,
    scopeId: r.scopeId,
    action: r.action,
    before: r.before,
    after: r.after,
    metadata: r.metadata
  }))))
  return auditRows.length
}

async function addConsentLogEntry(entries: Entries, db: Db, userId: number): Promise<number> {
  const consentRows = await db
    .select()
    .from(consentLog)
    .where(eq(consentLog.userId, userId))
    .orderBy(asc(consentLog.createdAt))
  entries['consent.ndjson'] = strToU8(toNdjson(consentRows.map(c => ({
    purpose: c.purpose,
    granted: c.granted,
    version: c.version,
    locale: c.locale,
    ipTruncated: c.ipTruncated,
    userAgentHash: c.userAgentHash,
    createdAt: c.createdAt.toISOString()
  }))))
  return consentRows.length
}

/**
 * Open workspace invitations: addressed to the user's email, and sent by
 * the user. Token hashes are never exported.
 */
async function addWorkspaceInvitesEntry(entries: Entries, userId: number, email: string | null): Promise<number> {
  const { received, sent } = await listInvitesForExport(userId, normaliseInviteEmail(email))
  entries['workspace_invites.json'] = strToU8(JSON.stringify({
    received: received.map(r => ({
      workspaceName: r.workspaceName,
      role: r.role,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString()
    })),
    sent: sent.map(s => ({
      workspaceId: s.workspaceId,
      email: s.email,
      role: s.role,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString()
    }))
  }, null, 2))
  return received.length + sent.length
}

/**
 * Paid-plans waitlist rows linked to the account (sign-ups made while
 * signed in). Token hashes are deliberately not exported — see
 * `listWaitlistSignupsForUser`.
 */
async function addWaitlistEntry(entries: Entries, userId: number): Promise<number> {
  const rows = await listWaitlistSignupsForUser(userId)
  entries['waitlist.ndjson'] = strToU8(toNdjson(rows))
  return rows.length
}

/**
 * Abuse reports the user filed while signed in (DSA Art.16 notices):
 * the user's own fields, the status, the decision as it was SENT to them
 * (action, rule, explanation) and the notices addressed to them as the
 * reporter. Never the internal moderator notes, the moderator's identity,
 * or anything about the reported document's owner.
 */
async function addAbuseReportsEntry(entries: Entries, db: Db, userId: number): Promise<number> {
  const reports = await db
    .select({
      reportId: abuseReports.reportId,
      contentUrl: abuseReports.contentUrl,
      docId: abuseReports.docId,
      category: abuseReports.category,
      body: abuseReports.body,
      reporterName: abuseReports.reporterName,
      reporterEmail: abuseReports.reporterEmail,
      reporterLocale: abuseReports.reporterLocale,
      reporterIpTruncated: abuseReports.reporterIpTruncated,
      goodFaithConfirmedAt: abuseReports.goodFaithConfirmedAt,
      status: abuseReports.status,
      decisionAction: abuseReports.decisionAction,
      decisionRule: abuseReports.decisionRule,
      decisionExplanation: abuseReports.decisionExplanation,
      createdAt: abuseReports.createdAt,
      acknowledgedAt: abuseReports.acknowledgedAt,
      actionedAt: abuseReports.actionedAt
    })
    .from(abuseReports)
    .where(eq(abuseReports.reporterUserId, userId))
    .orderBy(asc(abuseReports.createdAt))
  const notices = reports.length === 0
    ? []
    : await db
        .select({
          reportId: moderationNotices.reportId,
          kind: moderationNotices.kind,
          status: moderationNotices.status,
          locale: moderationNotices.locale,
          subject: moderationNotices.subject,
          body: moderationNotices.body,
          createdAt: moderationNotices.createdAt
        })
        .from(moderationNotices)
        .where(and(
          inArray(moderationNotices.reportId, reports.map(r => r.reportId)),
          eq(moderationNotices.recipientRole, 'reporter')
        ))
        .orderBy(asc(moderationNotices.createdAt))
  entries['abuse_reports.ndjson'] = strToU8(toNdjson(reports.map(r => ({
    reportId: r.reportId,
    contentUrl: r.contentUrl,
    docId: r.docId,
    category: r.category,
    body: r.body,
    reporterName: r.reporterName,
    reporterEmail: r.reporterEmail,
    reporterLocale: r.reporterLocale,
    reporterIpTruncated: r.reporterIpTruncated,
    goodFaithConfirmedAt: r.goodFaithConfirmedAt?.toISOString() ?? null,
    status: r.status,
    decision: r.decisionAction === null
      ? null
      : { action: r.decisionAction, rule: r.decisionRule, explanation: r.decisionExplanation },
    createdAt: r.createdAt.toISOString(),
    acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
    closedAt: r.actionedAt?.toISOString() ?? null,
    noticesSentToYou: notices
      .filter(n => n.reportId === r.reportId)
      .map(n => ({ kind: n.kind, status: n.status, locale: n.locale, subject: n.subject, body: n.body, createdAt: n.createdAt.toISOString() }))
  }))))
  return reports.length
}

/**
 * Statements of reasons (DSA Art.17) the user received as the owner of a
 * removed / restricted document. The notice text contains no reporter
 * data, so it is exported as sent.
 */
async function addOwnerNoticesEntry(entries: Entries, db: Db, userId: number): Promise<number> {
  const rows = await db
    .select({
      reportId: moderationNotices.reportId,
      kind: moderationNotices.kind,
      status: moderationNotices.status,
      locale: moderationNotices.locale,
      subject: moderationNotices.subject,
      body: moderationNotices.body,
      createdAt: moderationNotices.createdAt
    })
    .from(moderationNotices)
    .where(and(eq(moderationNotices.recipientUserId, userId), eq(moderationNotices.recipientRole, 'owner')))
    .orderBy(asc(moderationNotices.createdAt))
  entries['moderation_notices.ndjson'] = strToU8(toNdjson(rows.map(n => ({
    reference: n.reportId,
    kind: n.kind,
    status: n.status,
    locale: n.locale,
    subject: n.subject,
    body: n.body,
    createdAt: n.createdAt.toISOString()
  }))))
  return rows.length
}

/**
 * Bring-your-own-key AI provider configs. Exported WITHOUT the key —
 * neither the ciphertext nor the last four characters: an export ZIP
 * travels by email link and must not become a credential carrier.
 */
async function addAiProvidersEntry(entries: Entries, userId: number): Promise<number> {
  const rows = await listAiProviders(userId)
  entries['ai/providers.json'] = strToU8(JSON.stringify(rows.map(r => ({
    capability: r.capability,
    baseUrl: r.baseUrl,
    model: r.model,
    supportsVision: r.supportsVision,
    supportsTools: r.supportsTools,
    lastVerifiedAt: r.lastVerifiedAt ? r.lastVerifiedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString()
  })), null, 2))
  return rows.length
}

/**
 * Stripe billing — best-effort. Failures land an error marker so the
 * user can re-request later; no Stripe customer at all emits empty
 * placeholders for layout stability. Invoices capped at 100 to
 * survive malicious / weird state without blowing the export.
 */
/** Workspace subscriptions the user manages as billing admin (always written). */
async function addWorkspaceSubscriptionsEntry(entries: Entries, userId: number): Promise<number> {
  const rows = await listSubscriptionsByBillingAdmin(userId)
  entries['billing/workspace_subscriptions.json'] = strToU8(JSON.stringify(rows.map(r => ({
    workspaceId: r.workspaceId,
    plan: r.plan,
    seats: r.seats,
    status: r.status,
    validUntil: r.validUntil?.toISOString() ?? null,
    currency: r.currency,
    interval: r.interval,
    createdAt: r.createdAt.toISOString()
  })), null, 2))
  return rows.length
}

/** Personal AI credit top-ups (always written; WP4). */
async function addCreditGrantsEntry(entries: Entries, userId: number): Promise<number> {
  const rows = await listGrants({ type: 'user', id: String(userId) })
  entries['billing/ai_credits.json'] = strToU8(JSON.stringify(rows.map(r => ({
    pack: r.pack,
    creditUsd: r.amountUsd,
    remainingUsd: r.remainingUsd,
    refundedUsd: r.refundedUsd,
    amountPaid: r.amountPaid,
    currency: r.currency,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString()
  })), null, 2))
  return rows.length
}

/**
 * Single sign-on (WP14): the workspace identity providers this account
 * is linked to — which workspace, the protocol, the subject the IdP
 * knows you by, whether provisioning (SCIM) disabled it, last sign-in.
 */
async function addSsoIdentitiesEntry(entries: Entries, userId: number): Promise<number> {
  const rows = await useDatabase().select({
    workspaceId: ssoConnections.workspaceId,
    protocol: ssoConnections.protocol,
    subject: userIdentities.subject,
    active: userIdentities.active,
    createdAt: userIdentities.createdAt,
    lastLoginAt: userIdentities.lastLoginAt
  }).from(userIdentities)
    .innerJoin(ssoConnections, eq(ssoConnections.id, userIdentities.connectionId))
    .where(eq(userIdentities.userId, userId))
  entries['sso_identities.json'] = strToU8(JSON.stringify(rows.map(r => ({
    workspaceId: r.workspaceId,
    protocol: r.protocol,
    subject: r.subject,
    active: r.active,
    linkedAt: r.createdAt.toISOString(),
    lastSignInAt: r.lastLoginAt?.toISOString() ?? null
  })), null, 2))
  return rows.length
}

/**
 * Workspace guests (WP11): documents shared with this account as a
 * guest, and the shares this account granted to guests.
 */
async function addDocumentSharesEntry(entries: Entries, userId: number): Promise<void> {
  const db = useDatabase()
  const cols = {
    docId: documentShares.docId,
    title: documents.title,
    workspaceId: documents.workspaceId,
    userId: documentShares.userId,
    access: documentShares.access,
    grantedByUserId: documentShares.grantedByUserId,
    createdAt: documentShares.createdAt
  }
  const [received, granted] = await Promise.all([
    db.select(cols).from(documentShares).innerJoin(documents, eq(documents.docId, documentShares.docId)).where(eq(documentShares.userId, userId)),
    db.select(cols).from(documentShares).innerJoin(documents, eq(documents.docId, documentShares.docId)).where(eq(documentShares.grantedByUserId, userId))
  ])
  const view = (r: typeof received[number]) => ({ docId: r.docId, title: r.title, workspaceId: r.workspaceId, access: r.access, sharedAt: r.createdAt.toISOString() })
  entries['document_shares.json'] = strToU8(JSON.stringify({
    received: received.map(view),
    // The guest's account id only — their profile isn't yours to export.
    granted: granted.map(r => ({ ...view(r), guestUserId: r.userId }))
  }, null, 2))
}

/** Brand kit (WP10): the fonts and logos this account uploaded to a workspace. */
async function addBrandAssetsEntry(entries: Entries, userId: number): Promise<void> {
  const rows = await useDatabase().select({
    workspaceId: workspaceBrandAssets.workspaceId,
    kind: workspaceBrandAssets.kind,
    name: workspaceBrandAssets.name,
    weight: workspaceBrandAssets.weight,
    style: workspaceBrandAssets.style,
    format: workspaceBrandAssets.format,
    createdAt: workspaceBrandAssets.createdAt
  }).from(workspaceBrandAssets).where(eq(workspaceBrandAssets.uploadedBy, userId))
  entries['brand_assets.json'] = strToU8(JSON.stringify(rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })), null, 2))
}

/** Publishing (WP13): web pages of documents you own, your custom domains. */
async function addPublishingEntries(entries: Entries, userId: number): Promise<void> {
  const pages = await listPublishedPagesForOwner(userId)
  entries['published_pages.json'] = strToU8(JSON.stringify(pages.map(p => ({
    docId: p.docId,
    slug: p.slug,
    title: p.title,
    indexable: p.indexable,
    publishedAt: p.publishedAt.toISOString(),
    updatedAt: p.updatedAt.toISOString()
  })), null, 2))
  const domains = await listCustomDomainsForUser(userId)
  // No verification token: it's a credential for the domain check.
  entries['custom_domains.json'] = strToU8(JSON.stringify(domains.map(d => ({
    hostname: d.hostname,
    status: d.status,
    lastCheckProblem: d.lastError,
    verifiedAt: d.verifiedAt?.toISOString() ?? null,
    lastCheckedAt: d.lastCheckedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    showsDocument: d.pageDocId
  })), null, 2))
}

async function addBillingEntries(entries: Entries, stripeCustomerId: string | null): Promise<number> {
  // Billing off → no Stripe client exists on this deployment; emit the
  // same empty placeholders as "no Stripe customer" so the layout stays
  // stable and the export never fails on billing.
  if (!stripeCustomerId || !isBillingEnabled()) {
    entries['billing/customer.json'] = strToU8('{}')
    entries['billing/invoices.ndjson'] = strToU8('')
    return 0
  }
  try {
    const stripe = useStripeClient()
    if (!stripe) {
      entries['billing/customer.json'] = strToU8('{"error":"stripe client unavailable; export was built without billing data"}')
      entries['billing/invoices.ndjson'] = strToU8('')
      return 0
    }
    const customer = await stripe.customers.retrieve(stripeCustomerId)
    entries['billing/customer.json'] = strToU8(JSON.stringify(customer, null, 2))
    const list = await stripe.invoices.list({ customer: stripeCustomerId, limit: 100 })
    const invoices = list.data as unknown as Record<string, unknown>[]
    entries['billing/invoices.ndjson'] = strToU8(toNdjson(invoices))
    return invoices.length
  } catch (e) {
    Sentry.captureException(e, {
      tags: { component: 'dataExport', event: 'stripe_fetch_failed' }
    })
    const msg = e instanceof Error ? e.message : String(e)
    entries['billing/customer.json'] = strToU8(JSON.stringify({ error: `stripe fetch failed: ${msg}` }, null, 2))
    entries['billing/invoices.ndjson'] = strToU8('')
    return 0
  }
}

function toNdjson(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return ''
  return rows.map(r => JSON.stringify(r)).join('\n') + '\n'
}
