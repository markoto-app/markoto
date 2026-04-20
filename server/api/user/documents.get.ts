import { eq, sql } from 'drizzle-orm'
import { documents } from '../../db/schema'

// "My Documents" for the dashboard. Returns docs the caller owns. Workspace
// docs they don't own stay inside the workspace view — keeps this list
// semantically "my stuff" vs. "everything I can edit".
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const db = useDatabase()
  const userId = session.user.id

  const docs = await db.select({
    docId: documents.docId,
    title: documents.title,
    accessMode: documents.accessMode,
    wordCount: documents.wordCount,
    lastActive: documents.lastActive,
    sizeBytes: documents.sizeBytes,
    isOwner: sql<boolean>`true`
  })
    .from(documents)
    .where(eq(documents.ownerId, userId))
    .orderBy(sql`${documents.lastActive} DESC`)

  return docs
})
