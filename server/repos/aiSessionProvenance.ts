import { and, asc, eq } from 'drizzle-orm'
import { aiSessionProvenance } from '../db/schema'
import { useDatabase } from '../db/client'
import { proofActingUserId, type DocAccess, type UserScope } from './proofs'

// Provenance of in-editor AI sessions for the taint gate
// (`server/repos/docProvenance.ts`). One row per session, written when
// the session is claimed (`clean = false`) and flipped to `clean = true`
// only after the session ended untainted — see the table comment in
// `server/db/schema/ai.ts`. Fail-closed by construction: every path that
// does not reach `markAiSessionProvenanceClean` leaves the session's
// edits counted as somebody else's.
//
// A session's row is keyed by the write proof the session was opened with:
// its document and the user it was decided for.

/** Record that `sessionId` acts for the proof's user on the proof's document. Starts not-clean. */
export async function recordAiSessionProvenance(doc: DocAccess<'write'>, sessionId: string): Promise<void> {
  const db = useDatabase()
  await db.insert(aiSessionProvenance).values({ sessionId, docId: doc.docId, userId: proofActingUserId(doc), clean: false })
}

/**
 * Mark the session's output as the invoker's own. Call only after the
 * AI client has left the document and only when the session never read
 * content written by someone else.
 */
export async function markAiSessionProvenanceClean(doc: DocAccess<'write'>, sessionId: string): Promise<void> {
  const db = useDatabase()
  await db.update(aiSessionProvenance)
    .set({ clean: true })
    .where(and(
      eq(aiSessionProvenance.sessionId, sessionId),
      eq(aiSessionProvenance.docId, doc.docId),
      eq(aiSessionProvenance.userId, proofActingUserId(doc))
    ))
}

export interface AiSessionProvenanceRow {
  sessionId: string
  docId: string
  clean: boolean
  createdAt: Date
}

/** Every provenance row of `userId`, oldest first (data export). */
export async function listAiSessionProvenanceForUser(user: UserScope): Promise<AiSessionProvenanceRow[]> {
  const userId = user.userId
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
