import { zipSync, strToU8 } from 'fflate'
import { and, asc, eq, sql } from 'drizzle-orm'
import * as Sentry from '@sentry/nuxt'
import {
  activityLog,
  aiSessionMessages,
  aiSessions,
  auditLog,
  consentLog,
  documentComments,
  documents,
  themes,
  users,
  workspaceMembers,
  workspaces
} from '../db/schema'
import { useDatabase } from './database'
import { reconstructTextAtYjsId } from './historyReplay'
import { useStripeClient } from './stripeClient'

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
//   themes.json                     ← saved themes
//   ai/sessions.ndjson
//   ai/messages.ndjson              ← prompt + tool-call history
//   ai/usage.ndjson                 ← per-period interaction counter
//   activity.ndjson                 ← rows where user_id = $userId
//   audit.ndjson                    ← rows scoped to or by the user
//   consent.ndjson
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
  themes.json            saved themes you've created.
  ai/sessions.ndjson     AI sessions you initiated.
  ai/messages.ndjson     AI prompt + tool-call history (NDJSON).
  ai/usage.ndjson        per-billing-period AI interaction counters.
  activity.ndjson        activity-log rows attributed to you.
  audit.ndjson           audit-log rows actioned by you OR scoped to
                         your user id.
  consent.ndjson         every consent decision you have made.
  billing/customer.json  your Stripe customer record (if billing was
                         set up).
  billing/invoices.ndjson  your Stripe invoice history (if any).

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
    themes: number
    aiSessions: number
    aiSessionMessages: number
    activityLogRows: number
    auditLogRows: number
    consentLogRows: number
    invoices: number
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
  const themesCount = await addThemesEntry(entries, db, userId)
  const { sessionsCount, messagesCount } = await addAiEntries(entries, db, userId)
  // Phase 6: ai_usage_period table dropped (LiteLLM owns spend state).
  // No usage history to export — LiteLLM's spend logs are operator-
  // facing only. If a user requests historical AI usage in the future,
  // re-add via a separate `/spend/logs` proxy.
  const activityCount = await addActivityLogEntry(entries, db, userId)
  const auditCount = await addAuditLogEntry(entries, db, userId)
  const consentCount = await addConsentLogEntry(entries, db, userId)
  const invoicesCount = await addBillingEntries(entries, userRow.stripeCustomerId)

  return {
    bytes: zipSync(entries, { level: 6 }),
    counts: {
      documents: documentsCount,
      comments: commentsCount,
      workspaceMemberships: membershipsCount,
      themes: themesCount,
      aiSessions: sessionsCount,
      aiSessionMessages: messagesCount,
      activityLogRows: activityCount,
      auditLogRows: auditCount,
      consentLogRows: consentCount,
      invoices: invoicesCount
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
    avatarUrl: userRow.avatarUrl,
    githubLinked: userRow.githubId !== null,
    googleLinked: userRow.googleId !== null,
    plan: userRow.plan,
    planValidUntil: userRow.planValidUntil?.toISOString() ?? null,
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
 * Stripe billing — best-effort. Failures land an error marker so the
 * user can re-request later; no Stripe customer at all emits empty
 * placeholders for layout stability. Invoices capped at 100 to
 * survive malicious / weird state without blowing the export.
 */
async function addBillingEntries(entries: Entries, stripeCustomerId: string | null): Promise<number> {
  if (!stripeCustomerId) {
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
