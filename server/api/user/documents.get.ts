import { eq, or, sql } from 'drizzle-orm'
import { documents, documentShares } from '../../db/schema'

export default defineEventHandler(async (event) => {
  const session = await requireUserSession(event)
  const db = useDatabase()
  const userId = session.user.id

  const docs = db.select({
    docId: documents.docId,
    title: documents.title,
    accessMode: documents.accessMode,
    wordCount: documents.wordCount,
    lastActive: documents.lastActive,
    sizeBytes: documents.sizeBytes,
    isOwner: sql<boolean>`${documents.ownerId} = ${userId}`
  })
    .from(documents)
    .leftJoin(documentShares, sql`${documentShares.docId} = ${documents.docId} AND ${documentShares.userId} = ${userId}`)
    .where(or(
      eq(documents.ownerId, userId),
      sql`${documentShares.userId} IS NOT NULL`
    ))
    .orderBy(sql`${documents.lastActive} DESC`)
    .all()

  return docs
})
