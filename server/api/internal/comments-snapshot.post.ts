import { docExists } from '../../repos/documents'
import type { CommentSnapshotRow } from '../../repos/comments'
import { eq, sql } from 'drizzle-orm'
import { documentComments } from '../../db/schema'
import { useDatabase } from '../../utils/platform/database'
import { appendActivity, pruneActivity } from '../../repos/activity'
import { diffCommentsSnapshot } from '../../utils/documents/commentsSnapshotDiff'
import { normalizeAvatarSeed } from '../../../shared/utils/documents/awarenessUser'
import { requireInternalSecret } from '../../utils/platform/internalRoutes'

// Internal endpoint called by the sync-server on every persisted save of a doc
// with a non-empty `comments` Y.Array. The body carries the FULL list of
// comment entries (root + replies); the doc's rows in `document_comments` are
// replaced atomically.
//
// Eventually consistent: the mirror lags live Y.js by the y-postgresql flush
// interval, which is fine for its cross-doc queries (mention notifications,
// recent activity).
//
// Auth: X-Internal-Secret, enforced for all of /api/internal/** by
// server/middleware/auth.ts; repeated here so the handler is safe on its own.

interface IncomingEntry {
  entryId?: string
  parentCommentId?: string | null
  authorId?: number | null
  authorName?: string
  authorAvatarSeed?: string | null
  body?: string
  createdAt?: number
  updatedAt?: number
  resolved?: boolean
}

const MAX_ENTRIES_PER_DOC = 5000
const MAX_BODY_LENGTH = 8000 // the loosest comment cap, with headroom

interface ParsedBody {
  docId: string
  entries: IncomingEntry[]
  yjsDocIdBefore: number | null
  yjsDocIdAfter: number | null
}

export default defineEventHandler(async (event) => {
  requireInternalSecret(event)
  const body = parseSnapshotBody(await readBody(event))

  // Anonymous / direct-URL docs without a DB row are skipped, as in the
  // activity endpoint.
  if (!(await docExists(body.docId))) return { ok: true, mirrored: false }

  const rows = body.entries
    .map(buildSnapshotRow)
    .filter((r): r is CommentSnapshotRow => r !== null)

  const events = await replaceSnapshotInTx(body.docId, rows)
  await recordSnapshotEvents(body, events, anonAvatarSeedsByEntry(body.entries))

  return { ok: true, mirrored: true, rowCount: rows.length, activityEvents: events.length }
})

function parseSnapshotBody(body: unknown): ParsedBody {
  const b = body as { docId?: unknown, entries?: unknown, yjsDocIdBefore?: unknown, yjsDocIdAfter?: unknown }
  if (!b.docId || typeof b.docId !== 'string') {
    throw createError({ statusCode: 400, message: 'Missing docId' })
  }
  if (!Array.isArray(b.entries)) {
    throw createError({ statusCode: 400, message: 'entries must be an array' })
  }
  if (b.entries.length > MAX_ENTRIES_PER_DOC) {
    throw createError({ statusCode: 413, message: 'Too many entries in snapshot' })
  }
  return {
    docId: b.docId,
    entries: b.entries as IncomingEntry[],
    yjsDocIdBefore: typeof b.yjsDocIdBefore === 'number' ? b.yjsDocIdBefore : null,
    yjsDocIdAfter: typeof b.yjsDocIdAfter === 'number' ? b.yjsDocIdAfter : null
  }
}

/**
 * Shapes one incoming entry into a `CommentSnapshotRow`, or null when a
 * required field is missing or mistyped so one corrupt row can't block the
 * whole snapshot.
 */
function buildSnapshotRow(e: IncomingEntry): CommentSnapshotRow | null {
  if (typeof e.entryId !== 'string' || e.entryId.length === 0 || e.entryId.length > 64) return null
  if (typeof e.authorName !== 'string') return null
  if (typeof e.body !== 'string') return null
  if (typeof e.createdAt !== 'number' || typeof e.updatedAt !== 'number') return null
  return {
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
  }
}

/**
 * Read prev, diff, replace and return events, all inside one transaction under
 * a per-doc advisory lock. Without it, two concurrent pushes both see the prev
 * rows and both DELETE+INSERT in `replaceCommentSnapshot`, and the second hits
 * the (doc_id, entry_id) unique constraint (500). The xact lock releases on
 * commit or rollback.
 */
async function replaceSnapshotInTx(
  docId: string,
  rows: CommentSnapshotRow[]
): Promise<ReturnType<typeof diffCommentsSnapshot>> {
  const db = useDatabase()
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${docId}))`)
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
      .where(eq(documentComments.docId, docId))

    const events = diffCommentsSnapshot(previous, rows)
    await tx.delete(documentComments).where(eq(documentComments.docId, docId))
    if (rows.length > 0) {
      await tx.insert(documentComments).values(rows.map(r => ({
        docId,
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
    return events
  })
}

/**
 * Anonymous authors' avatar tokens by comment id, for the activity rows only
 * (the mirror table doesn't store them; they live on the comment in Y.js). A
 * deleted comment has none, so its row falls back to the name-seeded avatar.
 */
function anonAvatarSeedsByEntry(entries: IncomingEntry[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const e of entries) {
    if (typeof e.entryId !== 'string' || typeof e.authorId === 'number') continue
    const seed = normalizeAvatarSeed(e.authorAvatarSeed)
    if (seed) out.set(e.entryId, seed)
  }
  return out
}

/** Build the activity-row metadata for a snapshot event by kind. */
function metadataForEvent(e: ReturnType<typeof diffCommentsSnapshot>[number]) {
  if (e.kind === 'comment.replied') {
    return { kind: e.kind, commentId: e.commentId, parentCommentId: e.parentCommentId, bodyPreview: e.bodyPreview }
  }
  if (e.kind === 'comment.deleted') {
    return { kind: e.kind, commentId: e.commentId, bodyPreview: e.bodyPreview, isReply: e.isReply }
  }
  return { kind: e.kind, commentId: e.commentId, bodyPreview: e.bodyPreview }
}

/** Append one activity row per snapshot event, then prune. */
async function recordSnapshotEvents(
  body: ParsedBody,
  events: ReturnType<typeof diffCommentsSnapshot>,
  anonSeeds: Map<string, string>
): Promise<void> {
  for (const e of events) {
    const metadata = metadataForEvent(e)
    await appendActivity({
      docId: body.docId,
      userId: e.userId,
      userName: e.userName,
      actorAvatarSeed: e.userId === null ? anonSeeds.get(e.commentId) ?? null : null,
      action: e.kind,
      metadata,
      yjsDocIdBefore: body.yjsDocIdBefore,
      yjsDocIdAfter: body.yjsDocIdAfter
    })
  }
  if (events.length > 0) await pruneActivity(body.docId)
}
