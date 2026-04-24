import { getDoc, setDocPassword, clearDocPassword } from '../../../repos/documents'

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)
  const body = await readBody(event)

  const doc = await getDoc(docId)
  if (!doc) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  const { action, password } = body as { action: 'set' | 'verify' | 'remove', password?: string }

  // SET password — doc owner or workspace admin. `canManageDoc` encapsulates
  // the orthogonal "doc owner vs workspace admin" branches; both can change
  // access controls. Editors / viewers cannot.
  if (action === 'set') {
    const session = await requireValidatedUserSession(event)
    if (!(await canManageDoc(session.user.id, docId))) {
      throw createError({ statusCode: 403, message: 'Not authorized to manage this document' })
    }
    if (!password || password.length < 4) {
      throw createError({ statusCode: 400, message: 'Password must be at least 4 characters' })
    }

    const hash = await hashPassword(password)
    await setDocPassword(docId, hash)

    return { success: true }
  }

  // VERIFY password — anyone (rate-limited)
  if (action === 'verify') {
    const ip = getRequestHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
      || getRequestHeader(event, 'x-real-ip')
      || 'unknown'
    const rateLimitKey = `${ip}:${docId}`

    if (!(await checkRateLimit('password-verify', rateLimitKey, 5, 60_000))) {
      throw createError({
        statusCode: 429,
        message: 'Too many attempts. Try again in a minute.',
        data: { code: 'password/rate-limited', messageKey: 'error.rateLimited' }
      })
    }

    if (!password) {
      throw createError({ statusCode: 400, message: 'Password required' })
    }
    if (!doc.passwordHash) {
      throw createError({ statusCode: 400, message: 'Document has no password' })
    }

    const valid = await verifyPassword(doc.passwordHash, password)
    if (!valid) {
      throw createError({
        statusCode: 401,
        message: 'Invalid password',
        data: { code: 'password/invalid' }
      })
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

  // REMOVE password — doc owner or workspace admin.
  if (action === 'remove') {
    const session = await requireValidatedUserSession(event)
    if (!(await canManageDoc(session.user.id, docId))) {
      throw createError({ statusCode: 403, message: 'Not authorized to manage this document' })
    }

    await clearDocPassword(docId)

    return { success: true }
  }

  throw createError({ statusCode: 400, message: 'Invalid action' })
})
