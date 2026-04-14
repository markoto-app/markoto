import { eq, and, lt } from 'drizzle-orm'
import { aiSessions } from '../db/schema'

/**
 * AI session registry.
 *
 * Metadata (session_id, initiator, startedAt, …) lives in Postgres so:
 *   - Per-user-per-doc cap survives a Nitro restart (UNIQUE index enforces it
 *     at the DB level; an INSERT that would duplicate fails with constraint
 *     error — we translate that to `DuplicateSessionError`).
 *   - The sweeper can reap stale entries left behind by a crash.
 *
 * AbortControllers themselves stay in-process memory, keyed by sessionId.
 * They can't be serialized, and aborts only need to work within the process
 * that's running the Anthropic loop anyway. If a request to /api/ai/abort
 * lands on a different process than the one running the loop (future
 * multi-worker setup) it will see the DB row but no local controller —
 * `getAiSession` returns the row with `abortController: null`, and the abort
 * endpoint treats that as "stuck, just drop it from the registry".
 */

export interface ActiveAISession {
  sessionId: string
  docId: string
  initiatorUserId: number
  initiatorName: string
  initiatorColor: string
  startedAt: Date
  /** May be null if this process didn't start the session. */
  abortController: AbortController | null
}

// Local-only — only contains controllers for sessions started in THIS process.
const localControllers = new Map<string, AbortController>()

export class DuplicateSessionError extends Error {
  constructor() {
    super('User already has Claude running on this document')
  }
}

export async function hasUserAiSession(userId: number, docId: string): Promise<boolean> {
  const db = useDatabase()
  const row = (await db
    .select({ sessionId: aiSessions.sessionId })
    .from(aiSessions)
    .where(and(eq(aiSessions.initiatorUserId, userId), eq(aiSessions.docId, docId)))
    .limit(1))[0]
  return !!row
}

export async function addAiSession(session: Omit<ActiveAISession, 'abortController'> & { abortController: AbortController }): Promise<void> {
  const db = useDatabase()
  try {
    await db.insert(aiSessions).values({
      sessionId: session.sessionId,
      docId: session.docId,
      initiatorUserId: session.initiatorUserId,
      initiatorName: session.initiatorName,
      initiatorColor: session.initiatorColor,
      startedAt: session.startedAt
    })
  } catch (e: any) {
    // Postgres unique-violation code → per-user cap hit. Belt-and-suspenders:
    // also accept a substring match in case the driver reshapes the error.
    if (e?.code === '23505' || /duplicate key value|unique constraint/i.test(String(e?.message ?? ''))) {
      throw new DuplicateSessionError()
    }
    throw e
  }
  localControllers.set(session.sessionId, session.abortController)
}

export async function removeAiSession(sessionId: string): Promise<void> {
  const db = useDatabase()
  await db.delete(aiSessions).where(eq(aiSessions.sessionId, sessionId))
  localControllers.delete(sessionId)
}

export async function getAiSession(sessionId: string): Promise<ActiveAISession | undefined> {
  const db = useDatabase()
  const row = (await db
    .select()
    .from(aiSessions)
    .where(eq(aiSessions.sessionId, sessionId))
    .limit(1))[0]
  if (!row) return undefined
  return {
    sessionId: row.sessionId,
    docId: row.docId,
    initiatorUserId: row.initiatorUserId,
    initiatorName: row.initiatorName,
    initiatorColor: row.initiatorColor,
    startedAt: row.startedAt,
    abortController: localControllers.get(sessionId) ?? null
  }
}

/**
 * All sessions currently registered in the DB. Used by the sweeper.
 */
export async function snapshotAiSessions(): Promise<ActiveAISession[]> {
  const db = useDatabase()
  const rows = await db.select().from(aiSessions)
  return rows.map((row) => ({
    sessionId: row.sessionId,
    docId: row.docId,
    initiatorUserId: row.initiatorUserId,
    initiatorName: row.initiatorName,
    initiatorColor: row.initiatorColor,
    startedAt: row.startedAt,
    abortController: localControllers.get(row.sessionId) ?? null
  }))
}

/**
 * Delete rows older than `olderThanMs`. Used at startup to clean up entries
 * left behind by a previous process crash, and by the sweeper during runtime.
 * Returns the number of rows deleted.
 */
export async function purgeStaleAiSessions(olderThanMs: number): Promise<number> {
  const db = useDatabase()
  const cutoff = new Date(Date.now() - olderThanMs)
  const result = await db
    .delete(aiSessions)
    .where(lt(aiSessions.startedAt, cutoff))
    .returning({ sessionId: aiSessions.sessionId })
  return result.length
}
