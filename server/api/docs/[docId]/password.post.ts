import type { H3Event } from 'h3'
import { getDoc, setDocPassword, clearDocPassword, type DocSnapshot } from '../../../repos/documents'
import { appendAuditEvent } from '../../../repos/audit'

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)
  const body = await readBody(event)
  const doc = await getDoc(docId)
  if (!doc) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  const { action, password } = body as { action: 'set' | 'verify' | 'remove', password?: string }

  if (action === 'set') return handleSet(event, docId, doc, password)
  if (action === 'verify') return handleVerify(event, docId, doc, password)
  if (action === 'remove') return handleRemove(event, docId, doc)
  throw createError({ statusCode: 400, message: 'Invalid action' })
})

/** Best-effort client-IP extraction for rate-limit + audit attribution. */
function extractIp(event: H3Event): string | null {
  return getRequestHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
    || getRequestHeader(event, 'x-real-ip')
    || null
}

/**
 * SET password — doc owner or workspace admin. `canManageDoc`
 * encapsulates the orthogonal "doc owner vs workspace admin" branches;
 * both can change access controls. Editors / viewers cannot.
 */
async function handleSet(event: H3Event, docId: string, doc: DocSnapshot, password: string | undefined) {
  const session = await requireValidatedUserSession(event)
  if (!(await canManageDoc(session.user.id, docId))) {
    throw createError({ statusCode: 403, message: 'Not authorized to manage this document' })
  }
  if (!password || password.length < 4) {
    throw createError({ statusCode: 400, message: 'Password must be at least 4 characters' })
  }

  const hash = await hashPassword(password)
  await setDocPassword(docId, hash)

  // Never log the password itself — record presence + access-mode
  // transition only. `setDocPassword` flips access_mode to
  // password-protected, so the after-state always has hasPassword=true.
  await appendAuditEvent({
    actorUserId: session.user.id,
    actorIp: extractIp(event),
    scope: 'doc',
    scopeId: docId,
    action: 'doc.password_set',
    before: { accessMode: doc.accessMode, hasPassword: !!doc.passwordHash },
    after: { accessMode: 'password-protected', hasPassword: true }
  })

  return { success: true }
}

/** VERIFY password — anyone (rate-limited 5/IP+docId/min). */
async function handleVerify(event: H3Event, docId: string, doc: DocSnapshot, password: string | undefined) {
  const ip = extractIp(event) ?? 'unknown'
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

  return { success: true, token: await mintEditToken(event, docId), readOnly: false }
}

/** Mint a 2h edit JWT for a verified caller. Carries name for sync-server attribution — matches token.get.ts. */
async function mintEditToken(event: H3Event, docId: string): Promise<string> {
  const jwt = await import('jsonwebtoken')
  const config = useRuntimeConfig()
  if (!config.jwtSecret) {
    throw createError({ statusCode: 500, message: 'JWT secret not configured' })
  }
  const session = await getValidatedUserSession(event)
  return jwt.default.sign(
    {
      docId,
      userId: session?.user?.id || 'anonymous',
      userName: session?.user?.name ?? null,
      readOnly: false
    },
    config.jwtSecret,
    { expiresIn: '2h' }
  )
}

/** REMOVE password — doc owner or workspace admin. */
async function handleRemove(event: H3Event, docId: string, doc: DocSnapshot) {
  const session = await requireValidatedUserSession(event)
  if (!(await canManageDoc(session.user.id, docId))) {
    throw createError({ statusCode: 403, message: 'Not authorized to manage this document' })
  }

  await clearDocPassword(docId)

  // `clearDocPassword` flips access_mode back to open-edit.
  await appendAuditEvent({
    actorUserId: session.user.id,
    actorIp: extractIp(event),
    scope: 'doc',
    scopeId: docId,
    action: 'doc.password_removed',
    before: { accessMode: doc.accessMode, hasPassword: !!doc.passwordHash },
    after: { accessMode: 'open-edit', hasPassword: false }
  })

  return { success: true }
}
