import { and, eq, lt } from 'drizzle-orm'
import { aiSessions } from '../db/schema'
import { useDatabase } from '../db/client'
import type { DocAccess, SystemActor, UserScope } from './proofs'

// The AI session registry rows (`ai_sessions`): one running session per
// user and document (unique index). Opening one takes the write proof of the
// document. A session row is otherwise addressed by its random session id,
// constrained to its initiator (`UserScope`): another user's session id finds
// nothing. Only the stale-session sweeper reaches every row (`SystemActor`).

export type AiSessionRow = typeof aiSessions.$inferSelect

/** Register a session on the proof's document; throws on the per-user-per-doc unique index. */
export async function insertAiSession(doc: DocAccess<'write'>, session: Omit<typeof aiSessions.$inferInsert, 'docId'>): Promise<void> {
  await useDatabase().insert(aiSessions).values({ ...session, docId: doc.docId })
}

export async function hasAiSessionOn(self: UserScope, docId: string): Promise<boolean> {
  const row = (await useDatabase()
    .select({ sessionId: aiSessions.sessionId })
    .from(aiSessions)
    .where(and(eq(aiSessions.initiatorUserId, self.userId), eq(aiSessions.docId, docId)))
    .limit(1))[0]
  return !!row
}

/** The initiator's own session row, or null (unknown id, or another user's session). */
export async function getAiSessionRow(self: UserScope, sessionId: string): Promise<AiSessionRow | null> {
  return (await useDatabase().select().from(aiSessions)
    .where(and(eq(aiSessions.sessionId, sessionId), eq(aiSessions.initiatorUserId, self.userId)))
    .limit(1))[0] ?? null
}

/** Release the initiator's own session; no-op for another user's session id. */
export async function deleteAiSessionRow(self: UserScope, sessionId: string): Promise<void> {
  await useDatabase().delete(aiSessions)
    .where(and(eq(aiSessions.sessionId, sessionId), eq(aiSessions.initiatorUserId, self.userId)))
}

/** The sweeper drops an orphaned session whoever started it. */
export async function deleteAnyAiSessionRow(_by: SystemActor, sessionId: string): Promise<void> {
  await useDatabase().delete(aiSessions).where(eq(aiSessions.sessionId, sessionId))
}

/** Every registered session (the stale-session sweeper). */
export async function listAiSessionRows(_by: SystemActor): Promise<AiSessionRow[]> {
  return useDatabase().select().from(aiSessions)
}

/** Drop sessions started before `cutoff`; returns how many. */
export async function deleteAiSessionsStartedBefore(_by: SystemActor, cutoff: Date): Promise<number> {
  return (await useDatabase().delete(aiSessions).where(lt(aiSessions.startedAt, cutoff)).returning({ sessionId: aiSessions.sessionId })).length
}
