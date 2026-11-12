import { and, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm'
import { activityLog, users, aiSessions, mcpSessions } from '../db/schema'
import { useDatabase } from '../utils/platform/database'
import type { ActivityAction, ActivityMetadata } from '~~/shared/contracts/activity'

// Activity-log repository. Append-mostly; each doc is capped to its most
// recent 500 rows.

// The action list and the per-action metadata shapes are the activity
// contract shared with the sync server and the client feed.
export type { ActivityAction, ActivityMetadata } from '~~/shared/contracts/activity'

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
   * Boundary `yjs_updates.id` values around the store event; the diff
   * endpoint replays both to compute a textual diff. Null for action types not
   * tied to a store event.
   */
  yjsDocIdBefore: number | null
  yjsDocIdAfter: number | null
  /**
   * Raw synthetic-principal label on the row; null for human edits. Read by
   * `enrichActivityAgentFields` to resolve the `agent*` fields.
   */
  actorPrincipal: string | null
  /**
   * Anonymous rows only: the random per-tab avatar token from the editor's
   * presence broadcast, so the feed shows the same face.
   */
  actorAvatarSeed: string | null
  /**
   * Agent kind derived from the `actorPrincipal` prefix; null for human edits
   * and older AI rows (the UI shows those as "AI Assistant" via a `userName`
   * fallback).
   */
  agentKind: 'ai' | 'mcp' | null
  /**
   * Human who initiated the agent action, resolved via
   * ai_sessions.initiator_user_id or mcp_sessions.user_id. Null for non-agent
   * rows or when the session row has been swept.
   */
  agentInitiatorUserId: number | null
  agentInitiatorName: string | null
  /**
   * MCP only: `mcp_sessions.client_name` ("Claude Desktop", "Cursor"), falling
   * back to the UA string.
   */
  agentClientName: string | null
  createdAt: Date
}

export interface AppendInput {
  docId: string
  // Omitted and explicit `null` are equivalent: both mean no value for this nullable column.
  userId?: number | null
  userName: string | null
  /**
   * Synthetic-principal label for agent-driven rows (`'ai:assistant:{aiSessionId}'`,
   * `'mcp:{mcpSessionId}'`), taken from the JWT userId when non-numeric. NULL
   * for human and anonymous edits. See `activity_log.actor_principal` in
   * `server/db/schema.ts` for the join chain.
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
 * Result of `appendActivity`. `inserted=false` means the partial unique index
 * `uq_activity_doc_yjsafter` swallowed the row (the cross-instance flush race);
 * most callers ignore it.
 */
export interface AppendActivityResult {
  inserted: boolean
  rowId: number | null
}

export async function appendActivity(input: AppendInput): Promise<AppendActivityResult> {
  const db = useDatabase()
  // The conflict target only matches the partial index for rows inside it
  // (non-null `yjsDocIdAfter`, actions 'edit' / 'title.changed' /
  // 'theme.changed'); other rows insert unconditionally.
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
    // `where` is the index_predicate Postgres needs to infer the partial unique
    // index `uq_activity_doc_yjsafter` as arbiter; without it ON CONFLICT
    // errors because no full unique index exists.
    .onConflictDoNothing({
      target: [activityLog.docId, activityLog.yjsDocIdAfter],
      where: sql`yjs_doc_id_after IS NOT NULL AND action IN ('edit', 'title.changed', 'theme.changed')`
    })
    .returning({ id: activityLog.id })

  return { inserted: result.length > 0, rowId: result[0]?.id ?? null }
}

/**
 * Cap the log at MAX_ENTRIES_PER_DOC per document; runs after every append. A
 * single-value subquery (lowest id among the newest N) stays an index lookup;
 * OFFSET and NOT IN variants were slow on hot docs.
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

export async function listRecentActivity(docId: string, limit = 50, since: Date | null = null): Promise<ActivityEntry[]> {
  const db = useDatabase()
  // Agent enrichment is a separate batch step so this SQL stays simple and
  // can be skipped for pages without agent rows.
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
    .where(since
      ? and(eq(activityLog.docId, docId), gte(activityLog.createdAt, since))
      : eq(activityLog.docId, docId))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit)
  return enrichActivityAgentFields(rows)
}

/**
 * Whether the doc has activity rows older than `before` — lets the
 * activity endpoint tell the UI that a plan's history window hides some.
 */
export async function hasActivityBefore(docId: string, before: Date): Promise<boolean> {
  const db = useDatabase()
  const rows = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(and(eq(activityLog.docId, docId), lt(activityLog.createdAt, before)))
    .limit(1)
  return rows.length > 0
}

/** Raw activity row before agent enrichment: `ActivityEntry` minus the `agent*` fields. */
type RawActivityRow = Omit<
  ActivityEntry,
  'agentKind' | 'agentInitiatorUserId' | 'agentInitiatorName' | 'agentClientName'
>

/**
 * Resolve the human initiator and (MCP) client name for
 * `actor_principal`-tagged rows in three batched queries (ai_sessions,
 * mcp_sessions, users). No-op without agent rows; tolerates swept session rows
 * (`agentInitiatorName=null`, the UI falls back to `userName`).
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
      // client_name, else user_agent, else null; the UI renders
      // "{initiatorName} via {clientName ?? userAgent ?? 'MCP'}".
      const clientLabel = mcpRow?.clientName ?? mcpRow?.userAgent ?? null
      return {
        ...r,
        agentKind: 'mcp',
        agentInitiatorUserId: mcpRow?.userId ?? null,
        agentInitiatorName: initiator?.name ?? null,
        agentClientName: clientLabel
      }
    }
    // Unknown synthetic prefix: keep the row visible as a generic agent row
    // (agentKind null) instead of falling through to user-edit display.
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
 * Fetch one activity row by id for the diff endpoint. Null when missing or not
 * on the requested doc (both are 404).
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
  const enriched = await enrichActivityAgentFields(rows)
  return enriched[0] ?? null
}

/**
 * Filtered activity-log search, mainly for the AI's `search_activity_log` tool
 * ("revert X from yesterday" beyond the in-prompt history window). Filters
 * combine with AND: `actions`, `query` (case-insensitive substring of
 * metadata::text + user_name), `since`/`before` (UTC), `limit` (default 20,
 * max 50). Newest first. Always scoped to a single docId.
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
    // ILIKE on metadata::text covers every embedded field without a dedicated
    // index; the per-doc filter plus the 500-row prune cap keeps the scan
    // small. `%` / `_` are deliberately not escaped; odd input only hurts
    // recall.
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
  return enrichActivityAgentFields(rows)
}

export async function deleteActivityForDoc(docId: string): Promise<void> {
  const db = useDatabase()
  await db.delete(activityLog).where(eq(activityLog.docId, docId))
}
