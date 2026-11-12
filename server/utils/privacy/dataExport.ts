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
} from '../../db/schema'
import { useDatabase } from '../platform/database'
import { reconstructTextAtYjsId } from '../documents/historyReplay'
import { latestYjsId } from '../documents/yjsLog'
import { listAiSessionProvenanceForUser } from '../../repos/aiSessionProvenance'
import { ZIP_README } from './dataExportReadme'
import {
  addAiProvidersEntry,
  addBillingEntries,
  addCreditGrantsEntry,
  addPublishingEntries,
  addWaitlistEntry,
  addWorkspaceInvitesEntry,
  addWorkspaceSubscriptionsEntry,
  toNdjson,
  type ExportEntries
} from './dataExportSections'

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
//
// The sections that read tables directly are below; the ones that read
// through the repos or from Stripe are `dataExportSections.ts`, the
// archive's README.txt `dataExportReadme.ts`.

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
  // No AI usage history is exported: LiteLLM's spend logs are operator-facing only.
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

type Entries = ExportEntries

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
    // Generic OIDC: the issuer is the instance operator's own IdP;
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

/** Reconstruct a single doc's current markdown from its Y.js log, with Sentry-reported error fallback so one failed doc doesn't sink the whole export. */
async function reconstructDocMarkdown(docId: string): Promise<string> {
  try {
    return await reconstructTextAtYjsId(docId, await latestYjsId(docId))
  } catch (e) {
    Sentry.captureException(e, {
      tags: { component: 'dataExport', event: 'reconstruct_failed', docId }
    })
    return `[markoto] Document content could not be reconstructed at export time. Error: ${e instanceof Error ? e.message : String(e)}`
  }
}

async function addOwnedDocumentsEntries(entries: Entries, db: Db, userId: number): Promise<number> {
  const ownedDocs = await db
    .select()
    .from(documents)
    .where(eq(documents.ownerId, userId))
  for (const doc of ownedDocs) {
    const markdown = await reconstructDocMarkdown(doc.docId)
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
 * Single sign-on: the workspace identity providers this account
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
 * Workspace guests: documents shared with this account as a
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

/** Brand kit: the fonts and logos this account uploaded to a workspace. */
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
