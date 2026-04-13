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

  const session = await getValidatedUserSession(event)
  const db = useDatabase()
  const config = useRuntimeConfig()

  if (!config.jwtSecret) {
    throw createError({ statusCode: 500, message: 'JWT secret not configured' })
  }

  const doc = db.select().from(documents).where(eq(documents.docId, docId)).get()
  let readOnly = false
  let requiresPassword = false
  let forbidden = false
  const accessMode = doc?.accessMode ?? 'open-edit'
  const ownerId = doc?.ownerId ?? null

  if (doc) {
    const userId = session?.user?.id
    const isOwner = ownerId != null && typeof userId === 'number' && ownerId === userId

    if (doc.accessMode === 'private' && !isOwner) {
      // No token — same pattern as password-protected. Hocuspocus rejects the
      // connection so no content leaks. The client shows a private-document
      // lock screen with a prompt to log in or contact the owner.
      forbidden = true
      readOnly = true
    }

    if (doc.accessMode === 'open-view' && !isOwner) {
      readOnly = true
    }

    if (doc.accessMode === 'password-protected' && !isOwner) {
      requiresPassword = true
      readOnly = true
    }
  }

  // No-token exits: private (no path to unlock from the client) and
  // password-protected (unlocked after /password verify).
  if (forbidden || requiresPassword) {
    return { token: null, readOnly, requiresPassword, forbidden, accessMode, ownerId }
  }

  const token = jwt.sign(
    {
      docId,
      userId: session?.user?.id || 'anonymous',
      // Carried so the sync-server can attribute edits reliably without guessing
      // from awareness (a cursor move by User A can otherwise steal attribution
      // from a real edit by User B). Anonymous users end up with null here; the
      // sync-server falls back to awareness in that case.
      userName: session?.user?.name ?? null,
      readOnly
    },
    config.jwtSecret,
    { expiresIn: '2h' }
  )

  return { token, readOnly, requiresPassword, forbidden: false, accessMode, ownerId }
})
