import { eq } from 'drizzle-orm'
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
