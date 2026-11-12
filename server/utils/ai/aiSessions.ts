import { deleteAiSessionRow, deleteAiSessionsStartedBefore, getAiSessionRow, hasAiSessionOn, insertAiSession, listAiSessionRows, type AiSessionRow } from '../../repos/aiSessions'
import { system, type DocAccess, type UserScope } from '../../repos/proofs'

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
 * that's running the agentic loop anyway. If a request to /api/ai/abort
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
    super('User already has an AI session running on this document')
  }
}

export async function hasUserAiSession(self: UserScope, docId: string): Promise<boolean> {
  return hasAiSessionOn(self, docId)
}

/** Register a session on the document the write proof names (one per user and document). */
export async function addAiSession(doc: DocAccess<'write'>, session: Omit<ActiveAISession, 'abortController' | 'docId'> & { abortController: AbortController }): Promise<void> {
  try {
    await insertAiSession(doc, {
      sessionId: session.sessionId,
      initiatorUserId: session.initiatorUserId,
      initiatorName: session.initiatorName,
      initiatorColor: session.initiatorColor,
      startedAt: session.startedAt
    })
  } catch (e) {
    // Postgres 23505 = unique_violation. Drizzle wraps it in a
    // DrizzleQueryError whose `.cause` carries the original pg error
    // with `.code`. Walk the cause chain so the check works regardless
    // of which driver version is in use, and fall back to a message
    // substring match as belt-and-braces.
    const codes = new Set<string>()
    const messages: string[] = []
    let cur: unknown = e
    for (let depth = 0; cur && depth < 5; depth++) {
      const n = cur as { code?: string, message?: string, cause?: unknown }
      if (typeof n.code === 'string') codes.add(n.code)
      if (typeof n.message === 'string') messages.push(n.message)
      cur = n.cause
    }
    if (codes.has('23505') || messages.some(m => /duplicate key value|unique constraint/i.test(m))) {
      throw new DuplicateSessionError()
    }
    throw e
  }
  localControllers.set(session.sessionId, session.abortController)
}

export async function removeAiSession(sessionId: string): Promise<void> {
  await deleteAiSessionRow(sessionId)
  localControllers.delete(sessionId)
}

export async function getAiSession(sessionId: string): Promise<ActiveAISession | undefined> {
  const row = await getAiSessionRow(sessionId)
  return row ? toActiveSession(row) : undefined
}

function toActiveSession(row: AiSessionRow): ActiveAISession {
  return {
    sessionId: row.sessionId,
    docId: row.docId,
    initiatorUserId: row.initiatorUserId,
    initiatorName: row.initiatorName,
    initiatorColor: row.initiatorColor,
    startedAt: row.startedAt,
    abortController: localControllers.get(row.sessionId) ?? null
  }
}

/** The stale-session sweeper acts on every registered session. */
const SWEEPER = system('ai-session')

/**
 * All sessions currently registered in the DB. Used by the sweeper.
 */
export async function snapshotAiSessions(): Promise<ActiveAISession[]> {
  return (await listAiSessionRows(SWEEPER)).map(toActiveSession)
}

/**
 * Delete rows older than `olderThanMs`. Used at startup to clean up entries
 * left behind by a previous process crash, and by the sweeper during runtime.
 * Returns the number of rows deleted.
 */
export async function purgeStaleAiSessions(olderThanMs: number): Promise<number> {
  return deleteAiSessionsStartedBefore(SWEEPER, new Date(Date.now() - olderThanMs))
}
