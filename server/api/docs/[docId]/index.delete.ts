import { eq } from 'drizzle-orm'
import { documents } from '../../../db/schema'
import { deleteDocument } from '../../../utils/documentLifecycle'

// Owner-only delete endpoint. Ownership check stays here — the
// `deleteDocument` helper trusts its input and is also called from the
// inactive-doc sweeper, which has no user session to check against.

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const docId = requireDocId(event)
  const db = useDatabase()

  const doc = (await db.select({ ownerId: documents.ownerId })
    .from(documents)
    .where(eq(documents.docId, docId))
    .limit(1))[0]
  if (!doc) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }
  if (doc.ownerId !== session.user.id) {
    throw createError({ statusCode: 403, message: 'Not the document owner' })
  }

  await deleteDocument(docId)
  return { success: true }
})
