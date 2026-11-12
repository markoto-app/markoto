import { and, asc, eq, or } from 'drizzle-orm'
import { documentComments } from '../db/schema'
import { useDatabase } from '../utils/platform/database'

// Postgres mirror of the doc's comment threads. Y.js stays the source of truth;
// this is a write-side index for cross-doc queries (see schema.ts).

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
 * Replace the doc's mirrored comments with the snapshot (delete-then-insert in
 * one transaction). Empty snapshots are valid: the sync server sends one when
 * the last comment is cleared.
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
 * Resolve a comment thread by any entry id (root or reply): the root plus every
 * reply, chronological; null when the entry isn't on this doc. An activity row
 * references one (possibly reply) commentId, and the feed shows the whole
 * conversation up to that point.
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

  // One SELECT with OR instead of two, to save a round-trip.
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
      or(eq(documentComments.entryId, rootId), eq(documentComments.parentCommentId, rootId))
    ))
    .orderBy(asc(documentComments.createdAtMs))

  // Pin the root first regardless of createdAt (clock skew or edited timestamps can put it after a reply).
  const root = rows.find(r => r.entryId === rootId)
  const replies = rows.filter(r => r.entryId !== rootId)
  return root ? [root, ...replies] : rows
}
