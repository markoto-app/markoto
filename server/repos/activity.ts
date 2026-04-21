import { desc, eq, sql } from 'drizzle-orm'
import { activityLog } from '../db/schema'
import { useDatabase } from '../utils/database'

// Activity-log repository. Append-mostly table with a per-doc row cap
// (most-recent 500) to keep unbounded growth in check for docs with
// heavy edit traffic.

export type ActivityAction = 'edit' | 'join' | 'leave'

export interface ActivityEntry {
  id: number
  docId: string
  userName: string | null
  action: ActivityAction
  wordCount: number | null
  linesAdded: number | null
  linesRemoved: number | null
  createdAt: Date
}

export interface AppendInput {
  docId: string
  userName: string | null
  action: ActivityAction
  wordCount?: number | null
  linesAdded?: number | null
  linesRemoved?: number | null
}

const MAX_ENTRIES_PER_DOC = 500

export async function appendActivity(input: AppendInput): Promise<void> {
  const db = useDatabase()
  await db.insert(activityLog).values({
    docId: input.docId,
    userName: input.userName,
    action: input.action,
    wordCount: typeof input.wordCount === 'number' ? Math.round(input.wordCount) : null,
    linesAdded: typeof input.linesAdded === 'number' ? Math.max(0, Math.round(input.linesAdded)) : null,
    linesRemoved: typeof input.linesRemoved === 'number' ? Math.max(0, Math.round(input.linesRemoved)) : null
  })
}

/**
 * Cap the activity log at MAX_ENTRIES_PER_DOC per document. Called
 * after every append — deletes everything older than the top N rows.
 * Cheap because `idx_activity_doc` covers (docId, createdAt).
 */
export async function pruneActivity(docId: string): Promise<void> {
  const db = useDatabase()
  const count = (await db
    .select({ c: sql<number>`count(*)::int` })
    .from(activityLog)
    .where(eq(activityLog.docId, docId)))[0]

  if (!count || Number(count.c) <= MAX_ENTRIES_PER_DOC) return

  // Row id cutoff = the Nth most recent. Everything with a smaller id
  // for this doc gets dropped.
  const cutoff = (await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(eq(activityLog.docId, docId))
    .orderBy(desc(activityLog.id))
    .limit(1)
    .offset(MAX_ENTRIES_PER_DOC - 1))[0]
  if (!cutoff) return

  await db
    .delete(activityLog)
    .where(sql`${activityLog.docId} = ${docId} AND ${activityLog.id} < ${cutoff.id}`)
}

export async function listRecentActivity(docId: string, limit = 50): Promise<ActivityEntry[]> {
  const db = useDatabase()
  return db
    .select()
    .from(activityLog)
    .where(eq(activityLog.docId, docId))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit) as Promise<ActivityEntry[]>
}

/**
 * Delete every activity row for a doc. Called from deleteDocument.
 */
export async function deleteActivityForDoc(docId: string): Promise<void> {
  const db = useDatabase()
  await db.delete(activityLog).where(eq(activityLog.docId, docId))
}
