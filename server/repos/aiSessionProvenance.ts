import { asc, eq } from 'drizzle-orm'
import { aiSessionProvenance } from '../db/schema'
import { useDatabase } from '../utils/database'

// Provenance of in-editor AI sessions for the taint gate
// (`server/repos/docProvenance.ts`). One row per session, written when
// the session is claimed (`clean = false`) and flipped to `clean = true`
// only after the session ended untainted — see the table comment in
// `server/db/schema.ts`. Fail-closed by construction: every path that
// does not reach `markAiSessionProvenanceClean` leaves the session's
// edits counted as somebody else's.

/** Record that `sessionId` acts for `userId` on `docId`. Starts not-clean. */
export async function recordAiSessionProvenance(sessionId: string, docId: string, userId: number): Promise<void> {
  const db = useDatabase()
  await db.insert(aiSessionProvenance).values({ sessionId, docId, userId, clean: false })
}

/**
 * Mark the session's output as the invoker's own. Call only after the
 * AI client has left the document and only when the session never read
 * content written by someone else.
 */
export async function markAiSessionProvenanceClean(sessionId: string): Promise<void> {
  const db = useDatabase()
  await db.update(aiSessionProvenance)
    .set({ clean: true })
    .where(eq(aiSessionProvenance.sessionId, sessionId))
}

export interface AiSessionProvenanceRow {
  sessionId: string
  docId: string
  clean: boolean
  createdAt: Date
}

/** Every provenance row of `userId`, oldest first (data export). */
export async function listAiSessionProvenanceForUser(userId: number): Promise<AiSessionProvenanceRow[]> {
  const db = useDatabase()
  return db
    .select({
      sessionId: aiSessionProvenance.sessionId,
      docId: aiSessionProvenance.docId,
      clean: aiSessionProvenance.clean,
      createdAt: aiSessionProvenance.createdAt
    })
    .from(aiSessionProvenance)
    .where(eq(aiSessionProvenance.userId, userId))
    .orderBy(asc(aiSessionProvenance.createdAt))
}
