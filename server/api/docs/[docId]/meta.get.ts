import { eq } from 'drizzle-orm'
import { documents } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  const { docId } = getRouterParams(event)
  const db = useDatabase()

  const doc = db.select().from(documents).where(eq(documents.docId, docId)).get()

  if (!doc) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  return doc
})
