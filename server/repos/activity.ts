import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { activityLog, users, aiSessions, mcpSessions } from '../db/schema'
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
  /**
   * Raw synthetic-principal label stored on the row. `null` for human
   * edits + comment-snapshot rows that pre-date the actor_principal
   * column. Read by `enrichActivityAgentFields` to resolve the
   * `agent*` fields below.
   */
  actorPrincipal: string | null
  /**
   * Anonymous rows only: the random per-tab avatar token the editor's
   * presence broadcast, so the feed shows the same face. Null for
   * signed-in users (seeded by id), agents and older rows.
   */
  actorAvatarSeed: string | null
  /**
   * Agent kind, derived from `actorPrincipal` prefix. `null` for
   * human edits + legacy AI rows that pre-date the actor_principal
   * column (those still render as "AI Assistant" via the legacy
   * `userName === 'markoto' || 'AI Assistant'` fallback in the UI).
   */
  agentKind: 'ai' | 'mcp' | null
  /**
   * Real human who initiated the agent action — resolved via:
   *   ai:  actor_principal → ai_sessions.initiator_user_id → users
   *   mcp: actor_principal → mcp_sessions.user_id → users
   * `null` for non-agent rows OR when the session row has been
   * cleaned up (90-day sweeper for mcp_sessions, etc.).
   */
  agentInitiatorUserId: number | null
  agentInitiatorName: string | null
  /**
   * For MCP: `mcp_sessions.client_name` — friendly client label
   * ("Claude Desktop", "Cursor", etc.) captured from the
   * `initialize` call's `clientInfo.name`. Falls back to the UA
   * string when clientInfo wasn't captured. `null` for AI / human
   * rows.
   */
  agentClientName: string | null
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
  /**
   * Synthetic-principal label for agent-driven rows
   * (`'ai:assistant:{aiSessionId}'`, `'mcp:{mcpSessionId}'`). NULL
   * for human edits + anonymous edits. Sourced from the JWT.userId
   * when non-numeric (sync-server's `parseActorPrincipal`). Used by
   * `listRecentActivity`'s enrichment join to resolve the human
   * initiator + agent client name through the appropriate session
   * table. See `server/db/schema.ts` activity_log.actor_principal
   * comment for the join chain.
   */
  actorPrincipal?: string | null
  /** Anonymous rows only: the editor's awareness avatar token. */
  actorAvatarSeed?: string | null
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
    actorPrincipal: input.actorPrincipal ?? null,
    actorAvatarSeed: input.actorAvatarSeed ?? null,
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
  // The agent enrichment (resolving actorPrincipal → session table → initiator user) runs
  // as a separate batch step after the base select — keeps the SQL
  // straightforward and lets the enrichment short-circuit when the
  // page has no agent rows.
  const rows = await db
    .select({
      id: activityLog.id,
      docId: activityLog.docId,
      userId: activityLog.userId,
      userName: activityLog.userName,
      action: activityLog.action,
      wordCount: activityLog.wordCount,
      linesAdded: activityLog.linesAdded,
      linesRemoved: activityLog.linesRemoved,
      metadata: activityLog.metadata,
      yjsDocIdBefore: activityLog.yjsDocIdBefore,
      yjsDocIdAfter: activityLog.yjsDocIdAfter,
      actorPrincipal: activityLog.actorPrincipal,
      actorAvatarSeed: activityLog.actorAvatarSeed,
      createdAt: activityLog.createdAt
    })
    .from(activityLog)
    .where(eq(activityLog.docId, docId))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit)
  return enrichActivityAgentFields(rows as RawActivityRow[])
}

/**
 * Raw activity row before the agent-enrichment pass — base SQL
 * select shape. Identical to `ActivityEntry` minus the `agent*`
 * fields that the enrichment pass adds.
 */
type RawActivityRow = Omit<
  ActivityEntry,
  'agentKind' | 'agentInitiatorUserId' | 'agentInitiatorName' | 'agentClientName'
>

/**
 * Enrich `actor_principal`-tagged rows with the resolved human
 * initiator + (for MCP) client name. Three small batched queries:
 *   1. ai_sessions by sessionId  → initiator_user_id
 *   2. mcp_sessions by mcpSessionId → user_id, client_name, user_agent
 *   3. users by initiator id     → name
 *
 * No-ops cheaply when no rows have an `actor_principal`. Tolerant of
 * missing session rows (sweeper / cascade): such rows render with
 * `agentInitiatorName=null` — UI falls back to the row's `userName`
 * (e.g. 'AI Assistant' / 'MCP').
 */
async function enrichActivityAgentFields(rows: RawActivityRow[]): Promise<ActivityEntry[]> {
  const aiSessionIds = new Set<string>()
  const mcpSessionIds = new Set<string>()
  for (const r of rows) {
    if (!r.actorPrincipal) continue
    if (r.actorPrincipal.startsWith('ai:assistant:')) {
      aiSessionIds.add(r.actorPrincipal.slice('ai:assistant:'.length))
    } else if (r.actorPrincipal.startsWith('mcp:')) {
      mcpSessionIds.add(r.actorPrincipal.slice('mcp:'.length))
    }
  }
  if (aiSessionIds.size === 0 && mcpSessionIds.size === 0) {
    // No agent rows — return rows with the agent fields nulled.
    return rows.map(r => ({
      ...r,
      agentKind: null,
      agentInitiatorUserId: null,
      agentInitiatorName: null,
      agentClientName: null
    }))
  }

  const db = useDatabase()

  // Fetch session rows + collect initiator user ids.
  const aiRows = aiSessionIds.size === 0
    ? []
    : await db.select({
        sessionId: aiSessions.sessionId,
        initiatorUserId: aiSessions.initiatorUserId
      }).from(aiSessions).where(inArray(aiSessions.sessionId, Array.from(aiSessionIds)))
  const mcpRows = mcpSessionIds.size === 0
    ? []
    : await db.select({
        mcpSessionId: mcpSessions.mcpSessionId,
        userId: mcpSessions.userId,
        clientName: mcpSessions.clientName,
        userAgent: mcpSessions.userAgent
      }).from(mcpSessions).where(inArray(mcpSessions.mcpSessionId, Array.from(mcpSessionIds)))

  const aiBySid = new Map(aiRows.map(r => [r.sessionId, r]))
  const mcpBySid = new Map(mcpRows.map(r => [r.mcpSessionId, r]))

  // Batch-fetch initiator user info (name).
  const initiatorIds = new Set<number>()
  for (const r of aiRows) initiatorIds.add(r.initiatorUserId)
  for (const r of mcpRows) initiatorIds.add(r.userId)

  const userRows = initiatorIds.size === 0
    ? []
    : await db.select({
        id: users.id,
        name: users.name
      }).from(users).where(inArray(users.id, Array.from(initiatorIds)))
  const userById = new Map(userRows.map(r => [r.id, r]))

  // Stamp every row with the resolved agent fields (or nulls).
  return rows.map((r): ActivityEntry => {
    if (!r.actorPrincipal) {
      return {
        ...r,
        agentKind: null,
        agentInitiatorUserId: null,
        agentInitiatorName: null,
        agentClientName: null
      }
    }
    if (r.actorPrincipal.startsWith('ai:assistant:')) {
      const sid = r.actorPrincipal.slice('ai:assistant:'.length)
      const aiRow = aiBySid.get(sid)
      const initiator = aiRow ? userById.get(aiRow.initiatorUserId) : undefined
      return {
        ...r,
        agentKind: 'ai',
        agentInitiatorUserId: aiRow?.initiatorUserId ?? null,
        agentInitiatorName: initiator?.name ?? null,
        agentClientName: null
      }
    }
    if (r.actorPrincipal.startsWith('mcp:')) {
      const sid = r.actorPrincipal.slice('mcp:'.length)
      const mcpRow = mcpBySid.get(sid)
      const initiator = mcpRow ? userById.get(mcpRow.userId) : undefined
      // Display fallback: client_name (from clientInfo.name on
      // initialize) → user_agent (always captured) → null. The UI
      // formats "{initiatorName} via {clientName ?? userAgent ?? 'MCP'}".
      const clientLabel = mcpRow?.clientName ?? mcpRow?.userAgent ?? null
      return {
        ...r,
        agentKind: 'mcp',
        agentInitiatorUserId: mcpRow?.userId ?? null,
        agentInitiatorName: initiator?.name ?? null,
        agentClientName: clientLabel
      }
    }
    // Unknown synthetic prefix — render as a generic agent row so we
    // don't accidentally fall through to user-edit display. Stamps
    // agentKind: null but keeps the row visible.
    return {
      ...r,
      agentKind: null,
      agentInitiatorUserId: null,
      agentInitiatorName: null,
      agentClientName: null
    }
  })
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
      action: activityLog.action,
      wordCount: activityLog.wordCount,
      linesAdded: activityLog.linesAdded,
      linesRemoved: activityLog.linesRemoved,
      metadata: activityLog.metadata,
      yjsDocIdBefore: activityLog.yjsDocIdBefore,
      yjsDocIdAfter: activityLog.yjsDocIdAfter,
      actorPrincipal: activityLog.actorPrincipal,
      actorAvatarSeed: activityLog.actorAvatarSeed,
      createdAt: activityLog.createdAt
    })
    .from(activityLog)
    .where(and(eq(activityLog.id, activityId), eq(activityLog.docId, docId)))
    .limit(1)
  if (rows.length === 0) return null
  const enriched = await enrichActivityAgentFields(rows as RawActivityRow[])
  return enriched[0] ?? null
}

/**
 * Filtered activity-log search. The AI's `search_activity_log` tool
 * is the primary caller — long-term memory tier for "revert X from
 * yesterday" or "what info did you base that table on" queries that
 * fall outside the in-prompt `<conversation_history>` window.
 *
 * Filters layer multiplicatively:
 *   - actions: restrict to specific action types (e.g. ['restore', 'edit'])
 *   - query:   substring match against the row's metadata::text +
 *              user_name, case-insensitive. Cheap and adequate — the
 *              metadata column is small jsonb.
 *   - since/before: time window in UTC.
 *   - limit:   hard ceiling, default 20, max 50.
 *
 * Results are ordered most-recent-first so the model sees newest
 * matches first; the tool handler caps `limit` and renders into the
 * compact line format expected by the agentic loop.
 *
 * Doc-scoped by docId — never accepts a workspaceId or cross-doc
 * lookup, mirroring the rest of the activity-repo's tuple-key isolation.
 */
export interface SearchActivityOpts {
  actions?: ActivityAction[]
  query?: string
  since?: Date
  before?: Date
  limit?: number
}

export async function searchActivity(
  docId: string,
  opts: SearchActivityOpts = {}
): Promise<ActivityEntry[]> {
  const db = useDatabase()
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 50))

  const filters = [eq(activityLog.docId, docId)]
  if (opts.actions && opts.actions.length > 0) {
    filters.push(inArray(activityLog.action, opts.actions))
  }
  if (opts.since) filters.push(gte(activityLog.createdAt, opts.since))
  if (opts.before) filters.push(lte(activityLog.createdAt, opts.before))
  if (opts.query && opts.query.trim().length > 0) {
    // ILIKE on metadata::text covers every embedded field (commentId,
    // bodyPreview, query, prompt, summary, url, tool name, …) without a
    // dedicated index — the per-doc filter above keeps the scan small
    // (≤500 rows by the prune cap). Also matches `user_name` for
    // who-did-what queries. Pass-through %escaping: trust the model's
    // input as a literal — escapes for `%` / `_` are intentionally NOT
    // applied so a query like "comment.added" still matches; pathological
    // inputs only hurt recall, never correctness.
    const q = `%${opts.query.trim()}%`
    filters.push(
      sql`(${activityLog.metadata}::text ILIKE ${q} OR coalesce(${activityLog.userName}, '') ILIKE ${q})`
    )
  }

  const rows = await db
    .select({
      id: activityLog.id,
      docId: activityLog.docId,
      userId: activityLog.userId,
      userName: activityLog.userName,
      action: activityLog.action,
      wordCount: activityLog.wordCount,
      linesAdded: activityLog.linesAdded,
      linesRemoved: activityLog.linesRemoved,
      metadata: activityLog.metadata,
      yjsDocIdBefore: activityLog.yjsDocIdBefore,
      yjsDocIdAfter: activityLog.yjsDocIdAfter,
      actorPrincipal: activityLog.actorPrincipal,
      actorAvatarSeed: activityLog.actorAvatarSeed,
      createdAt: activityLog.createdAt
    })
    .from(activityLog)
    .where(and(...filters))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit)
  return enrichActivityAgentFields(rows as RawActivityRow[])
}

/**
 * Delete every activity row for a doc. Called from deleteDocument.
 */
export async function deleteActivityForDoc(docId: string): Promise<void> {
  const db = useDatabase()
  await db.delete(activityLog).where(eq(activityLog.docId, docId))
}
