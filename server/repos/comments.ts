import { and, asc, eq, or, sql } from 'drizzle-orm'
import { documentComments } from '../db/schema'
import { useDatabase } from '../db/client'
import type { DocAccess } from './proofs'

// Postgres mirror of the doc's comment threads. Y.js stays the source of truth;
// this is a write-side index for cross-doc queries (see server/db/schema/collab.ts).

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

export interface StoredCommentRow {
  entryId: string
  parentCommentId: string | null
  authorId: number | null
  authorName: string
  body: string
  resolved: boolean
}

/**
 * Replace the doc's mirrored comments with the snapshot (delete-then-insert in
 * one transaction) and return the rows it replaced, so the caller can diff
 * them. Empty snapshots are valid: the sync server sends one when the last
 * comment is cleared.
 *
 * Serialised per document with `pg_advisory_xact_lock`: two concurrent saves
 * would otherwise both read the old rows and both DELETE+INSERT, and the
 * second hits the (doc_id, entry_id) unique constraint. The lock releases on
 * commit or rollback.
 */
export async function replaceCommentSnapshot(doc: DocAccess<'write'>, rows: CommentSnapshotRow[]): Promise<StoredCommentRow[]> {
  const docId = doc.docId
  return useDatabase().transaction(async (tx) => {
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
    return previous
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
  doc: DocAccess<'view'>,
  entryId: string
): Promise<CommentThreadRow[] | null> {
  const docId = doc.docId
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
