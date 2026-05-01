import { and, desc, eq, sql } from 'drizzle-orm'
import { activityLog, users } from '../db/schema'
import { useDatabase } from '../utils/database'

// Activity-log repository. Append-mostly table with a per-doc row cap
// (most-recent 500) to keep unbounded growth in check for docs with
// heavy edit traffic.

export type ActivityAction
  = | 'edit'
    | 'join'
    | 'leave'
    | 'comment.added'
    | 'comment.replied'
    | 'comment.resolved'
    | 'comment.reopened'
    | 'comment.deleted'
    | 'theme.changed'
    | 'title.changed'
    | 'ai.tool'
    | 'restore'

export const ACTIVITY_ACTIONS: readonly ActivityAction[] = [
  'edit', 'join', 'leave',
  'comment.added', 'comment.replied',
  'comment.resolved', 'comment.reopened', 'comment.deleted',
  'theme.changed', 'title.changed', 'ai.tool',
  'restore'
]

// Per-action metadata shapes carried in the jsonb `metadata` column.
// UI renders human-readable strings via i18n at read time; row stays
// locale-agnostic.
//
// `comment.replied` carries `parentCommentId` so future UI can deep-link
// to the parent thread; `comment.deleted` carries `isReply` so the feed
// can show "deleted a reply" vs "deleted a thread" without re-querying
// the comments mirror (the row is gone by then).
export type ActivityMetadata
  = | { kind: 'comment.added' | 'comment.resolved' | 'comment.reopened'
    commentId: string
    bodyPreview: string }
    | { kind: 'comment.replied'
      commentId: string
      parentCommentId: string
      bodyPreview: string }
      | { kind: 'comment.deleted'
        commentId: string
        bodyPreview: string
        isReply: boolean }
        | { kind: 'title.changed', from: string, to: string }
        | { kind: 'theme.changed' }
        | { kind: 'ai.tool', tool: 'web_search', query: string, sources?: Array<{ title: string, uri: string }> }
        | { kind: 'ai.tool', tool: 'fetch_url', url: string, summary?: string, images?: Array<{ url: string, description?: string }> }
        | { kind: 'ai.tool', tool: 'generate_image', prompt: string }
        | { kind: 'ai.tool', tool: 'view_image', src: string }
        | { kind: 'ai.tool', tool: 'search_knowledge', query: string }
        | { kind: 'ai.tool', tool: 'get_knowledge_file', knowledgeId: string }
        | {
          kind: 'restore'
          /** Activity row id this restore was anchored at (the row whose
         *  yjsDocIdBefore the doc was reset to). */
          restoredFromActivityId: number
          /** ISO8601 timestamp of the row this restore was anchored at —
         *  shown in the UI as "From {relative time}". Frozen at restore
         *  time so the label doesn't drift if the source row's
         *  created_at is somehow updated later. */
          restoredFromTime: string
        }

export interface ActivityEntry {
  id: number
  docId: string
  userId: number | null
  userName: string | null
  /** Resolved at read time via JOIN — null for AI / anon / deleted users. */
  avatarUrl: string | null
  action: ActivityAction
  wordCount: number | null
  linesAdded: number | null
  linesRemoved: number | null
  metadata: ActivityMetadata | null
  /**
   * Boundary `yjs_documents.id` values captured around the store event
   * that produced this row. The diff endpoint replays the doc state at
   * both ids to compute a textual diff. Null on rows written before
   * this feature, or on action types that aren't tied to a store event.
   */
  yjsDocIdBefore: number | null
  yjsDocIdAfter: number | null
  createdAt: Date
}

export interface AppendInput {
  docId: string
  // Caller may either omit (action doesn't apply) OR explicitly pass
  // `null`. Both shapes are accepted because they both mean "no value
  // for this column." The handler treats omission as null. Drift
  // between callers is fine; the DB column is nullable either way.
  userId?: number | null
  userName: string | null
  action: ActivityAction
  wordCount?: number | null
  linesAdded?: number | null
  linesRemoved?: number | null
  metadata?: ActivityMetadata | null
  yjsDocIdBefore?: number | null
  yjsDocIdAfter?: number | null
}

const MAX_ENTRIES_PER_DOC = 500

/**
 * Result of `appendActivity`. `inserted=false` means the partial unique
 * index `uq_activity_doc_yjsafter` matched and the row was a no-op —
 * the documented cross-instance sync-server flush race landing softly.
 * Callers that don't care (most do not) can ignore the return value.
 */
export interface AppendActivityResult {
  inserted: boolean
  rowId: number | null
}

export async function appendActivity(input: AppendInput): Promise<AppendActivityResult> {
  const db = useDatabase()
  // `onConflictDoNothing` with `target=[docId, yjsDocIdAfter]` matches
  // the partial unique index. For rows that don't sit in the partial
  // index — null `yjsDocIdAfter`, or actions outside ('edit',
  // 'title.changed', 'theme.changed') — Postgres can't find a matching
  // unique constraint and the conflict target simply doesn't fire,
  // so those rows insert unconditionally.
  const result = await db.insert(activityLog).values({
    docId: input.docId,
    userId: input.userId ?? null,
    userName: input.userName,
    action: input.action,
    wordCount: typeof input.wordCount === 'number' ? Math.round(input.wordCount) : null,
    linesAdded: typeof input.linesAdded === 'number' ? Math.max(0, Math.round(input.linesAdded)) : null,
    linesRemoved: typeof input.linesRemoved === 'number' ? Math.max(0, Math.round(input.linesRemoved)) : null,
    metadata: input.metadata ?? null,
    yjsDocIdBefore: typeof input.yjsDocIdBefore === 'number' ? input.yjsDocIdBefore : null,
    yjsDocIdAfter: typeof input.yjsDocIdAfter === 'number' ? input.yjsDocIdAfter : null
  })
    // `where` here is Postgres's `index_predicate` — required so the
    // planner can infer the partial unique index `uq_activity_doc_yjsafter`
    // as the conflict arbiter. Without it, Postgres errors with `there
    // is no unique or exclusion constraint matching the ON CONFLICT
    // specification` because no full unique index on (doc_id,
    // yjs_doc_id_after) exists.
    .onConflictDoNothing({
      target: [activityLog.docId, activityLog.yjsDocIdAfter],
      where: sql`yjs_doc_id_after IS NOT NULL AND action IN ('edit', 'title.changed', 'theme.changed')`
    })
    .returning({ id: activityLog.id })

  return { inserted: result.length > 0, rowId: result[0]?.id ?? null }
}

/**
 * Cap the activity log at MAX_ENTRIES_PER_DOC per document. Called
 * after every append — deletes everything older than the top N rows.
 *
 * The DELETE uses a single subquery that returns ONE value (the lowest
 * id among the most-recent N rows), which Postgres's planner handles
 * efficiently against the (docId, createdAt) / (docId, id) index path.
 * Earlier shapes used OFFSET 500 (scans 500+N rows) or a NOT IN with a
 * 500-row materialised id list per call — both got slow at 100 writes/s
 * on a hot doc. The current shape is O(log N) index lookup + bounded
 * sorted scan limited to N rows.
 */
export async function pruneActivity(docId: string): Promise<void> {
  const db = useDatabase()
  await db.execute(sql`
    DELETE FROM ${activityLog}
    WHERE ${activityLog.docId} = ${docId}
      AND ${activityLog.id} < (
        SELECT MIN(id) FROM (
          SELECT ${activityLog.id} AS id FROM ${activityLog}
          WHERE ${activityLog.docId} = ${docId}
          ORDER BY ${activityLog.id} DESC
          LIMIT ${MAX_ENTRIES_PER_DOC}
        ) keep
      )
  `)
}

export async function listRecentActivity(docId: string, limit = 50): Promise<ActivityEntry[]> {
  const db = useDatabase()
  // LEFT JOIN users so we can stamp the row with the author's current
  // avatar URL. Null for AI rows (no FK) and for users who were deleted
  // since the activity row was written (FK has `set null`).
  const rows = await db
    .select({
      id: activityLog.id,
      docId: activityLog.docId,
      userId: activityLog.userId,
      userName: activityLog.userName,
      avatarUrl: users.avatarUrl,
      action: activityLog.action,
      wordCount: activityLog.wordCount,
      linesAdded: activityLog.linesAdded,
      linesRemoved: activityLog.linesRemoved,
      metadata: activityLog.metadata,
      yjsDocIdBefore: activityLog.yjsDocIdBefore,
      yjsDocIdAfter: activityLog.yjsDocIdAfter,
      createdAt: activityLog.createdAt
    })
    .from(activityLog)
    .leftJoin(users, eq(activityLog.userId, users.id))
    .where(eq(activityLog.docId, docId))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit)
  return rows as ActivityEntry[]
}

/**
 * Fetch a single activity row by id. Used by the diff endpoint to
 * pick up the boundary y-postgresql ids before replaying the doc.
 * Returns null when the row doesn't exist OR doesn't belong to the
 * requested doc — both produce 404 at the endpoint layer.
 */
export async function getActivityById(activityId: number, docId: string): Promise<ActivityEntry | null> {
  const db = useDatabase()
  const rows = await db
    .select({
      id: activityLog.id,
      docId: activityLog.docId,
      userId: activityLog.userId,
      userName: activityLog.userName,
      avatarUrl: users.avatarUrl,
      action: activityLog.action,
      wordCount: activityLog.wordCount,
      linesAdded: activityLog.linesAdded,
      linesRemoved: activityLog.linesRemoved,
      metadata: activityLog.metadata,
      yjsDocIdBefore: activityLog.yjsDocIdBefore,
      yjsDocIdAfter: activityLog.yjsDocIdAfter,
      createdAt: activityLog.createdAt
    })
    .from(activityLog)
    .leftJoin(users, eq(activityLog.userId, users.id))
    .where(and(eq(activityLog.id, activityId), eq(activityLog.docId, docId)))
    .limit(1)
  return (rows[0] as ActivityEntry | undefined) ?? null
}

/**
 * Delete every activity row for a doc. Called from deleteDocument.
 */
export async function deleteActivityForDoc(docId: string): Promise<void> {
  const db = useDatabase()
  await db.delete(activityLog).where(eq(activityLog.docId, docId))
}
