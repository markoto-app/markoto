import { eq } from 'drizzle-orm'
import { documents } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)
  const db = useDatabase()

  // Explicit projection — never ship `passwordHash` over a public endpoint.
  const doc = (await db
    .select({
      id: documents.id,
      docId: documents.docId,
      ownerId: documents.ownerId,
      title: documents.title,
      accessMode: documents.accessMode,
      sizeBytes: documents.sizeBytes,
      wordCount: documents.wordCount,
      theme: documents.theme,
      description: documents.description,
      audience: documents.audience,
      language: documents.language,
      templateId: documents.templateId,
      createdAt: documents.createdAt,
      lastActive: documents.lastActive
    })
    .from(documents)
    .where(eq(documents.docId, docId))
    .limit(1))[0]

  if (!doc) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  // Boolean is safe to expose; the hash itself is not.
  const hasPassword = doc.accessMode === 'password-protected'
  return { ...doc, hasPassword }
})
