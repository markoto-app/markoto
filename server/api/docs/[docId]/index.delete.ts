import { eq } from 'drizzle-orm'
import { documents, documentShares, workspaceDocuments, activityLog } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  const session = await requireUserSession(event)
  const { docId } = getRouterParams(event)
  const db = useDatabase()

  const doc = db.select({ ownerId: documents.ownerId }).from(documents).where(eq(documents.docId, docId)).get()
  if (!doc) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }
  if (doc.ownerId !== session.user.id) {
    throw createError({ statusCode: 403, message: 'Not the document owner' })
  }

  db.delete(activityLog).where(eq(activityLog.docId, docId)).run()
  db.delete(workspaceDocuments).where(eq(workspaceDocuments.docId, docId)).run()
  db.delete(documentShares).where(eq(documentShares.docId, docId)).run()
  db.delete(documents).where(eq(documents.docId, docId)).run()

  return { success: true }
})
