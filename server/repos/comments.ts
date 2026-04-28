import { and, asc, eq, or } from 'drizzle-orm'
import { documentComments } from '../db/schema'
import { useDatabase } from '../utils/database'

// Postgres mirror of the doc's comment threads. See schema.ts for the
// design rationale — Y.js stays the source of truth, this is a write-
// side index for cross-doc queries we don't yet expose but want the
// data for when we do.

export interface CommentSnapshotRow {
  entryId: string
  parentCommentId: string | null
  authorId: number | null
  authorName: string
  body: string
  createdAt: Date
  updatedAt: Date
  resolved: boolean
}

/**
 * Replace the doc's mirrored comments with the snapshot. Atomic
 * delete-then-insert inside a transaction so a partial write never
 * leaves the mirror in an inconsistent state.
 *
 * Empty snapshots are valid (deletes everything) — the sync server
 * sends one when the user clears the last comment.
 */
export async function replaceCommentSnapshot(docId: string, rows: CommentSnapshotRow[]): Promise<void> {
  const db = useDatabase()
  await db.transaction(async (tx) => {
    await tx.delete(documentComments).where(eq(documentComments.docId, docId))
    if (rows.length === 0) return
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
  })
}

/**
 * Resolve a comment thread by any entry id (root OR reply). Returns
 * the thread root + every reply, ordered chronologically. Returns
 * null when the entry doesn't exist for this doc.
 *
 * Used by the activity-feed comment-context expansion: an activity
 * row references a single `commentId` (possibly a reply) and we
 * want to show "the whole conversation up to this point" without
 * forcing the caller to walk the parent chain themselves.
 */
export interface CommentThreadRow {
  entryId: string
  parentCommentId: string | null
  authorId: number | null
  authorName: string
  body: string
  createdAt: Date
  updatedAt: Date
  resolved: boolean
}

export async function getCommentThreadByEntryId(
  docId: string,
  entryId: string
): Promise<CommentThreadRow[] | null> {
  const db = useDatabase()
  // First find the row to determine the thread root id.
  const [row] = await db
    .select({
      entryId: documentComments.entryId,
      parentCommentId: documentComments.parentCommentId
    })
    .from(documentComments)
    .where(and(eq(documentComments.docId, docId), eq(documentComments.entryId, entryId)))
    .limit(1)
  if (!row) return null

  const rootId = row.parentCommentId ?? row.entryId

  // Fetch the root + every row whose parentCommentId points at it.
  // Single SELECT with `OR` rather than two — keeps the round-trip
  // count down for the on-demand expansion.
  const rows = await db
    .select({
      entryId: documentComments.entryId,
      parentCommentId: documentComments.parentCommentId,
      authorId: documentComments.authorId,
      authorName: documentComments.authorName,
      body: documentComments.body,
      createdAt: documentComments.createdAtMs,
      updatedAt: documentComments.updatedAtMs,
      resolved: documentComments.resolved
    })
    .from(documentComments)
    .where(and(
      eq(documentComments.docId, docId),
      or(eq(documentComments.entryId, rootId), eq(documentComments.parentCommentId, rootId))!
    ))
    .orderBy(asc(documentComments.createdAtMs))

  // Sort: root first, then replies in createdAt order. The orderBy
  // above gives us chronological — but the root may have been
  // created AFTER a reply in some pathological case (clock skew /
  // edited timestamps). Force-pin the root regardless.
  const root = rows.find(r => r.entryId === rootId)
  const replies = rows.filter(r => r.entryId !== rootId)
  return root ? [root, ...replies] : rows
}
