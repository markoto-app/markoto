import { and, desc, eq, gte, lt } from 'drizzle-orm'
import type { SystemActor } from './proofs'
import { aiSessionMessages } from '../db/schema'
import { useDatabase } from '../db/client'
import { parseAiMessageEntry, type AiMessageEntry } from '../db/columnTypes'

export { parseAiMessageEntry, type AiMessageEntry } from '../db/columnTypes'

// Per-(doc, user) AI conversation memory. Append-only by convention: no
// `update`/`delete` exports, mirroring `audit.ts`. Rows disappear only through
// the cascade FK on doc/user delete. The `<conversation_history>` block in the
// system prompt is built from `loadRecentMessages(...)`; the hot read is "last
// N rows for (docId, userId), since the last idle gap".

export type AiMessageRow = {
  id: number
  docId: string
  userId: number
  sessionId: string
  createdAt: Date
} & AiMessageEntry

export type AppendAiMessageInput = {
  docId: string
  userId: number
  sessionId: string
} & AiMessageEntry

/**
 * Append one row to a user's per-doc AI memory. Fire-and-forget from
 * the loop's tool dispatch; failures are logged but never propagate.
 * The row is the audit trail of what the loop did, not the loop's
 * own correctness gate.
 */
export async function appendAiMessage(input: AppendAiMessageInput): Promise<void> {
  const db = useDatabase()
  await db.insert(aiSessionMessages).values({
    docId: input.docId,
    userId: input.userId,
    sessionId: input.sessionId,
    kind: input.kind,
    body: input.body
  })
}

/**
 * Load recent memory rows for a (docId, userId) pair, oldest-first
 * (chronological — the order the prompt builder wants when stitching
 * the `<conversation_history>` block).
 *
 * `since` cuts off the read at an idle-gap boundary so the conversation
 * doesn't grow unbounded across days; `limit` is a hard ceiling on the
 * number of rows the prompt will see, regardless of recency. Both
 * defaults are tuned in `conversationMemory.ts` (where the bloat-vs-
 * context tradeoff actually matters), this repo just enforces them.
 */
export async function loadRecentMessages(
  docId: string,
  userId: number,
  opts: { since?: Date, limit?: number } = {}
): Promise<AiMessageRow[]> {
  const db = useDatabase()
  const limit = Math.max(1, Math.min(opts.limit ?? 60, 200))

  // We need the LATEST `limit` rows but in chronological order in the
  // output. Order DESC + slice in the query to get the right window
  // off the index, then reverse client-side. Doing ORDER BY ASC LIMIT N
  // would return the OLDEST N — wrong direction.
  const conds = opts.since
    ? and(eq(aiSessionMessages.docId, docId), eq(aiSessionMessages.userId, userId), gte(aiSessionMessages.createdAt, opts.since))
    : and(eq(aiSessionMessages.docId, docId), eq(aiSessionMessages.userId, userId))

  const rows = await db
    .select({
      id: aiSessionMessages.id,
      docId: aiSessionMessages.docId,
      userId: aiSessionMessages.userId,
      sessionId: aiSessionMessages.sessionId,
      kind: aiSessionMessages.kind,
      body: aiSessionMessages.body,
      createdAt: aiSessionMessages.createdAt
    })
    .from(aiSessionMessages)
    .where(conds)
    .orderBy(desc(aiSessionMessages.createdAt))
    .limit(limit)

  // Reverse to chronological order — the prompt builder concatenates
  // forward in time so the model reads turn N before turn N+1.
  return [...rows].reverse().map(({ kind, body, ...row }) => ({ ...row, ...parseAiMessageEntry(kind, body) }))
}

/**
 * Find the timestamp of the most recent memory row for a (docId, userId).
 * Used by the prompt builder to compute the "last activity" reference
 * point so it can decide whether the current prompt is part of the
 * same conversation or a fresh one (idle-gap rotation).
 */
export async function lastActivityAt(docId: string, userId: number): Promise<Date | null> {
  const db = useDatabase()
  const row = await db
    .select({ createdAt: aiSessionMessages.createdAt })
    .from(aiSessionMessages)
    .where(and(eq(aiSessionMessages.docId, docId), eq(aiSessionMessages.userId, userId)))
    .orderBy(desc(aiSessionMessages.createdAt))
    .limit(1)
  return row[0]?.createdAt ?? null
}

/** Retention: conversation memory written before `cutoff`. Returns how many. */
export async function deleteAiMessagesBefore(_by: SystemActor, cutoff: Date): Promise<number> {
  return (await useDatabase().delete(aiSessionMessages).where(lt(aiSessionMessages.createdAt, cutoff)).returning({ id: aiSessionMessages.id })).length
}
