import { eq } from 'drizzle-orm'
import { documents } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)
  const body = await readBody(event)
  const db = useDatabase()

  const doc = (await db.select().from(documents).where(eq(documents.docId, docId)).limit(1))[0]
  if (!doc) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  const { action, password } = body as { action: 'set' | 'verify' | 'remove'; password?: string }

  // SET password — owner only
  if (action === 'set') {
    const session = await requireValidatedUserSession(event)
    if (doc.ownerId !== session.user.id) {
      throw createError({ statusCode: 403, message: 'Not the document owner' })
    }
    if (!password || password.length < 4) {
      throw createError({ statusCode: 400, message: 'Password must be at least 4 characters' })
    }

    const hash = await hashPassword(password)
    await db.update(documents)
      .set({ passwordHash: hash, accessMode: 'password-protected' })
      .where(eq(documents.docId, docId))

    return { success: true }
  }

  // VERIFY password — anyone (rate-limited)
  if (action === 'verify') {
    const ip = getRequestHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
      || getRequestHeader(event, 'x-real-ip')
      || 'unknown'
    const rateLimitKey = `${ip}:${docId}`

    if (!(await checkRateLimit('password-verify', rateLimitKey, 5, 60_000))) {
      throw createError({ statusCode: 429, message: 'Too many attempts. Try again in a minute.' })
    }

    if (!password) {
      throw createError({ statusCode: 400, message: 'Password required' })
    }
    if (!doc.passwordHash) {
      throw createError({ statusCode: 400, message: 'Document has no password' })
    }

    const valid = await verifyPassword(doc.passwordHash, password)
    if (!valid) {
      throw createError({ statusCode: 401, message: 'Invalid password' })
    }

    // Return a token granting edit access
    const jwt = await import('jsonwebtoken')
    const config = useRuntimeConfig()
    if (!config.jwtSecret) {
      throw createError({ statusCode: 500, message: 'JWT secret not configured' })
    }
    const session = await getValidatedUserSession(event)

    const token = jwt.default.sign(
      {
        docId,
        userId: session?.user?.id || 'anonymous',
        // Carry name for sync-server attribution — matches token.get.ts.
        userName: session?.user?.name ?? null,
        readOnly: false
      },
      config.jwtSecret,
      { expiresIn: '2h' }
    )

    return { success: true, token, readOnly: false }
  }

  // REMOVE password — owner only
  if (action === 'remove') {
    const session = await requireValidatedUserSession(event)
    if (doc.ownerId !== session.user.id) {
      throw createError({ statusCode: 403, message: 'Not the document owner' })
    }

    await db.update(documents)
      .set({ passwordHash: null, accessMode: 'open-edit' })
      .where(eq(documents.docId, docId))

    return { success: true }
  }

  throw createError({ statusCode: 400, message: 'Invalid action' })
})
