import { zipSync, strToU8 } from 'fflate'
import { and, asc, eq, sql } from 'drizzle-orm'
import * as Sentry from '@sentry/nuxt'
import {
  activityLog,
  aiSessionMessages,
  aiSessions,
  aiUsagePeriod,
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
    aiUsagePeriods: number
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

  // ── README ──────────────────────────────────────────────────────
  entries['README.txt'] = strToU8(ZIP_README)

  // ── profile.json ────────────────────────────────────────────────
  // Strip nothing here — `users` doesn't store password hashes (we
  // use OAuth) — but defensively project to the columns we want to
  // surface, so a future column addition doesn't accidentally leak.
  const profile = {
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
  entries['profile.json'] = strToU8(JSON.stringify(profile, null, 2))

  // ── Owned documents — markdown + meta ───────────────────────────
  // y-postgresql creates `yjs_documents` lazily on the first write
  // from the sync server. In environments where the sync server
  // hasn't run (CI repos tests, fresh dev DB) the table doesn't
  // exist yet — probe pg_class so we degrade gracefully to "no
  // history available; emit empty markdown" instead of crashing the
  // whole export.
  const yjsTableExistsRow = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_class WHERE relname = 'yjs_documents' AND relkind = 'r'
    ) AS exists
  `)
  const yjsTableExists = yjsTableExistsRow.rows?.[0]?.exists === true

  const ownedDocs = await db
    .select()
    .from(documents)
    .where(eq(documents.ownerId, userId))
  let documentsCount = 0
  for (const doc of ownedDocs) {
    documentsCount += 1
    // Reconstruct the doc's text from y-postgresql. Caps at 'now' —
    // we don't have a notion of a "boundary" for export; just want
    // the latest state. `null` for max id triggers the empty-doc
    // path; we want the full history so query the latest yjs id.
    let maxId: number | null = null
    if (yjsTableExists) {
      const latestYjs = await db.execute<{ max_id: number | null }>(sql`
        SELECT MAX(id)::int AS max_id FROM yjs_documents
        WHERE docname = ${doc.docId} AND version = 'v1'
      `)
      maxId = latestYjs.rows?.[0]?.max_id ?? null
    }
    let markdown = ''
    try {
      markdown = await reconstructTextAtYjsId(doc.docId, maxId)
    } catch (e) {
      // Don't fail the whole export on a doc reconstruction failure —
      // emit an explanatory marker file. Sentry-tagged so ops sees
      // it; orphaned y-postgresql state usually just means the
      // sync-server hasn't run for this doc.
      Sentry.captureException(e, {
        tags: { component: 'dataExport', event: 'reconstruct_failed', docId: doc.docId }
      })
      markdown = `[markoto] Document content could not be reconstructed at export time. Error: ${e instanceof Error ? e.message : String(e)}`
    }
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

  // ── Comments authored by the user ───────────────────────────────
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

  // ── Workspace memberships ───────────────────────────────────────
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

  // ── Saved themes ────────────────────────────────────────────────
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

  // ── AI sessions, messages, usage ────────────────────────────────
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

  const usageRows = await db
    .select()
    .from(aiUsagePeriod)
    .where(eq(aiUsagePeriod.attributedTo, `user:${userId}`))
    .orderBy(asc(aiUsagePeriod.periodStart))
  entries['ai/usage.ndjson'] = strToU8(toNdjson(usageRows.map(u => ({
    attributedTo: u.attributedTo,
    periodStart: u.periodStart.toISOString(),
    interactionsUsed: u.interactionsUsed,
    updatedAt: u.updatedAt.toISOString()
  }))))

  // ── Activity log rows attributed to the user ────────────────────
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

  // ── Audit log rows actioned BY the user OR scoped to them ───────
  // The user has a right of access to data ABOUT them — that
  // includes audit entries our system wrote where they were the
  // actor or where the audited entity was them (e.g.
  // account.delete_requested with scope_id = String(userId)).
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

  // ── Consent log ─────────────────────────────────────────────────
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

  // ── Stripe billing (best-effort) ────────────────────────────────
  let invoicesCount = 0
  if (userRow.stripeCustomerId) {
    try {
      const stripe = useStripeClient()
      if (stripe) {
        const customer = await stripe.customers.retrieve(userRow.stripeCustomerId)
        entries['billing/customer.json'] = strToU8(JSON.stringify(customer, null, 2))

        // Paginate invoices. For a single user this is small; cap
        // at 100 so a malicious / weird state can't blow the export.
        const invoices: Record<string, unknown>[] = []
        const list = await stripe.invoices.list({ customer: userRow.stripeCustomerId, limit: 100 })
        invoices.push(...(list.data as unknown as Record<string, unknown>[]))
        invoicesCount = invoices.length
        entries['billing/invoices.ndjson'] = strToU8(toNdjson(invoices))
      } else {
        entries['billing/customer.json'] = strToU8('{"error":"stripe client unavailable; export was built without billing data"}')
        entries['billing/invoices.ndjson'] = strToU8('')
      }
    } catch (e) {
      // Don't fail the whole export on Stripe being down — emit
      // an error marker so the user knows billing is missing,
      // and let them re-request later.
      Sentry.captureException(e, {
        tags: { component: 'dataExport', event: 'stripe_fetch_failed' }
      })
      const msg = e instanceof Error ? e.message : String(e)
      entries['billing/customer.json'] = strToU8(JSON.stringify({ error: `stripe fetch failed: ${msg}` }, null, 2))
      entries['billing/invoices.ndjson'] = strToU8('')
    }
  } else {
    // No Stripe customer — emit empty placeholder files for
    // layout-stability.
    entries['billing/customer.json'] = strToU8('{}')
    entries['billing/invoices.ndjson'] = strToU8('')
  }

  // ── Build the ZIP ───────────────────────────────────────────────
  const bytes = zipSync(entries, { level: 6 })

  return {
    bytes,
    counts: {
      documents: documentsCount,
      comments: comments.length,
      workspaceMemberships: memberships.length,
      themes: themesRows.length,
      aiSessions: sessionsRows.length,
      aiSessionMessages: aiMessagesRows.length,
      aiUsagePeriods: usageRows.length,
      activityLogRows: activityRows.length,
      auditLogRows: auditRows.length,
      consentLogRows: consentRows.length,
      invoices: invoicesCount
    }
  }
}

function toNdjson(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return ''
  return rows.map(r => JSON.stringify(r)).join('\n') + '\n'
}
