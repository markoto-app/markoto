import { eq, sql } from 'drizzle-orm'
import { documents } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const { docId } = getRouterParams(event)
  const body = await readBody(event)
  const db = useDatabase()

  const doc = db.select({ ownerId: documents.ownerId }).from(documents).where(eq(documents.docId, docId)).get()
  if (!doc) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }
  if (doc.ownerId !== session.user.id) {
    throw createError({ statusCode: 403, message: 'Not the document owner' })
  }

  const updates: Record<string, any> = {}

  if (body.title !== undefined) {
    if (typeof body.title !== 'string') throw createError({ statusCode: 400, message: 'Title must be a string' })
    if (body.title.length > 255) throw createError({ statusCode: 400, message: 'Title too long (max 255)' })
    updates.title = body.title.trim()
  }

  if (body.access_mode !== undefined) {
    const allowed = new Set(['open-edit', 'open-view', 'password-protected'])
    if (!allowed.has(body.access_mode)) throw createError({ statusCode: 400, message: 'Invalid access mode' })
    updates.accessMode = body.access_mode
  }

  if (typeof body.wordCount === 'number') {
    if (body.wordCount < 0 || body.wordCount > 10_000_000 || !Number.isFinite(body.wordCount)) {
      throw createError({ statusCode: 400, message: 'Invalid wordCount' })
    }
    updates.wordCount = Math.round(body.wordCount)
  }

  if (typeof body.sizeBytes === 'number') {
    if (body.sizeBytes < 0 || body.sizeBytes > 100_000_000 || !Number.isFinite(body.sizeBytes)) {
      throw createError({ statusCode: 400, message: 'Invalid sizeBytes' })
    }
    updates.sizeBytes = Math.round(body.sizeBytes)
  }

  if (Object.keys(updates).length > 0) {
    updates.lastActive = sql`(unixepoch())`
    db.update(documents).set(updates).where(eq(documents.docId, docId)).run()
  }

  return { success: true }
})
