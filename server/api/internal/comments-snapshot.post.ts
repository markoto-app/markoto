import { matchesCurrentOrPrevious } from '../../../shared/utils/secrets'
import { docExists } from '../../repos/documents'
import type { CommentSnapshotRow } from '../../repos/comments'
import { eq, sql } from 'drizzle-orm'
import { documentComments } from '../../db/schema'
import { useDatabase } from '../../utils/database'
import { appendActivity, pruneActivity } from '../../repos/activity'
import { diffCommentsSnapshot } from '../../utils/commentsSnapshotDiff'

// Internal endpoint called by the sync-server on every persisted save
// of a doc that has a non-empty `comments` Y.Array. The body carries
// the FULL list of comment-shaped entries (root + replies), and we
// replace the doc's rows in `document_comments` atomically.
//
// Eventually-consistent design: we accept that the mirror lags the
// live Y.js state by however long y-postgresql's batch flush takes
// (~200 updates or whatever the flushSize is set to). The mirror
// exists for cross-doc queries (mention notifications, recent
// activity) — none of those care about sub-second freshness.
//
// Auth: shared X-Internal-Secret header. Same shape as
// `internal/activity.post.ts`.

interface IncomingEntry {
  entryId?: string
  parentCommentId?: string | null
  authorId?: number | null
  authorName?: string
  body?: string
  createdAt?: number
  updatedAt?: number
  resolved?: boolean
}

const MAX_ENTRIES_PER_DOC = 5000
const MAX_BODY_LENGTH = 8000 // matches the loosest comment cap with headroom

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const providedSecret = getRequestHeader(event, 'x-internal-secret')

  if (!config.internalApiSecret) {
    throw createError({ statusCode: 500, message: 'Internal API secret not configured' })
  }
  if (!providedSecret || !matchesCurrentOrPrevious(
    providedSecret,
    config.internalApiSecret,
    config.internalApiSecretPrevious || undefined
  )) {
    throw createError({ statusCode: 401, message: 'Invalid internal secret' })
  }

  const body = await readBody(event) as {
    docId?: string
    entries?: IncomingEntry[]
    /** Boundary y-postgresql row ids around the triggering store. */
    yjsDocIdBefore?: number | null
    yjsDocIdAfter?: number | null
  }

  if (!body.docId || typeof body.docId !== 'string') {
    throw createError({ statusCode: 400, message: 'Missing docId' })
  }
  if (!Array.isArray(body.entries)) {
    throw createError({ statusCode: 400, message: 'entries must be an array' })
  }
  if (body.entries.length > MAX_ENTRIES_PER_DOC) {
    throw createError({ statusCode: 413, message: 'Too many entries in snapshot' })
  }

  // Anonymous / direct-URL docs without a DB row are skipped — same
  // posture as the activity endpoint. The mirror only makes sense
  // alongside a real document row.
  if (!(await docExists(body.docId))) {
    return { ok: true, mirrored: false }
  }

  const rows: CommentSnapshotRow[] = []
  for (const e of body.entries) {
    if (typeof e.entryId !== 'string' || e.entryId.length === 0 || e.entryId.length > 64) continue
    if (typeof e.authorName !== 'string') continue
    if (typeof e.body !== 'string') continue
    if (typeof e.createdAt !== 'number' || typeof e.updatedAt !== 'number') continue
    rows.push({
      entryId: e.entryId,
      parentCommentId: typeof e.parentCommentId === 'string' && e.parentCommentId.length > 0 && e.parentCommentId.length <= 64
        ? e.parentCommentId
        : null,
      authorId: typeof e.authorId === 'number' ? e.authorId : null,
      authorName: e.authorName.slice(0, 200),
      body: e.body.slice(0, MAX_BODY_LENGTH),
      createdAt: new Date(e.createdAt),
      updatedAt: new Date(e.updatedAt),
      resolved: Boolean(e.resolved)
    })
  }

  // Read prev → diff → replace → write events, ALL inside a single
  // transaction protected by a per-doc advisory lock. Without the
  // lock, two concurrent pushes for the same doc can both observe
  // the prev rows, both DELETE+INSERT inside `replaceCommentSnapshot`,
  // and the second one hits the (doc_id, entry_id) unique constraint
  // (yielding 500s) — caught by the integration concurrency suite.
  // The advisory-xact lock auto-releases when the transaction
  // commits or rolls back, so the lock can never leak.
  const db = useDatabase()
  const events = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${body.docId}))`)

    const previous = await tx
      .select({
        entryId: documentComments.entryId,
        parentCommentId: documentComments.parentCommentId,
        authorId: documentComments.authorId,
        authorName: documentComments.authorName,
        body: documentComments.body,
        resolved: documentComments.resolved
      })
      .from(documentComments)
      .where(eq(documentComments.docId, body.docId!))

    const computed = diffCommentsSnapshot(previous, rows)

    await tx.delete(documentComments).where(eq(documentComments.docId, body.docId!))
    if (rows.length > 0) {
      await tx.insert(documentComments).values(rows.map(r => ({
        docId: body.docId!,
        entryId: r.entryId,
        parentCommentId: r.parentCommentId,
        authorId: r.authorId,
        authorName: r.authorName,
        body: r.body,
        createdAtMs: r.createdAt,
        updatedAtMs: r.updatedAt,
        resolved: r.resolved
      })))
    }
    return computed
  })

  for (const e of events) {
    const metadata
      = e.kind === 'comment.replied'
        ? { kind: e.kind, commentId: e.commentId, parentCommentId: e.parentCommentId, bodyPreview: e.bodyPreview }
        : e.kind === 'comment.deleted'
          ? { kind: e.kind, commentId: e.commentId, bodyPreview: e.bodyPreview, isReply: e.isReply }
          : { kind: e.kind, commentId: e.commentId, bodyPreview: e.bodyPreview }
    await appendActivity({
      docId: body.docId,
      userId: e.userId,
      userName: e.userName,
      action: e.kind,
      metadata,
      yjsDocIdBefore: typeof body.yjsDocIdBefore === 'number' ? body.yjsDocIdBefore : null,
      yjsDocIdAfter: typeof body.yjsDocIdAfter === 'number' ? body.yjsDocIdAfter : null
    })
  }
  if (events.length > 0) await pruneActivity(body.docId)

  return { ok: true, mirrored: true, rowCount: rows.length, activityEvents: events.length }
})
