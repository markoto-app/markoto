import jwt from 'jsonwebtoken'
import { eq } from 'drizzle-orm'
import { documents } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  // Rate limit: 30 token requests per IP per minute
  const ip = getRequestHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
    || getRequestHeader(event, 'x-real-ip')
    || 'unknown'
  if (!checkRateLimit('token', ip, 30, 60_000)) {
    throw createError({ statusCode: 429, message: 'Too many requests. Try again later.' })
  }

  const docId = getRouterParam(event, 'docId')
  if (!docId) throw createError({ statusCode: 400, message: 'Missing docId' })

  const session = await getUserSession(event)
  const db = useDatabase()
  const config = useRuntimeConfig()

  if (!config.jwtSecret) {
    throw createError({ statusCode: 500, message: 'JWT secret not configured' })
  }

  const doc = db.select().from(documents).where(eq(documents.docId, docId)).get()
  let readOnly = false
  let requiresPassword = false
  const accessMode = doc?.accessMode ?? 'open-edit'
  const ownerId = doc?.ownerId ?? null

  if (doc) {
    const userId = session?.user?.id
    const isOwner = ownerId != null && typeof userId === 'number' && ownerId === userId

    if (doc.accessMode === 'open-view' && !isOwner) {
      readOnly = true
    }

    if (doc.accessMode === 'password-protected' && !isOwner) {
      requiresPassword = true
      readOnly = true
    }
  }

  // Password-protected docs: do NOT issue a token until password is verified.
  // Without a valid token, Hocuspocus will reject the connection entirely,
  // so no document content is leaked before password entry.
  if (requiresPassword) {
    return { token: null, readOnly, requiresPassword, accessMode, ownerId }
  }

  const token = jwt.sign(
    {
      docId,
      userId: session?.user?.id || 'anonymous',
      readOnly
    },
    config.jwtSecret,
    { expiresIn: '2h' }
  )

  return { token, readOnly, requiresPassword, accessMode, ownerId }
})
