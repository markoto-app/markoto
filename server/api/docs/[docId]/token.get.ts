import jwt from 'jsonwebtoken'
import { getDocWithActorRole } from '../../../repos/documents'
import { decideTokenAccess, type DocState, type ActorState } from '../../../../shared/utils/docPermissions'

export default defineEventHandler(async (event) => {
  // Rate limit: 30 token requests per IP per minute
  const ip = getRequestHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
    || getRequestHeader(event, 'x-real-ip')
    || 'unknown'
  if (!(await checkRateLimit('token', ip, 30, 60_000))) {
    throw createError({ statusCode: 429, message: 'Too many requests. Try again later.' })
  }

  const docId = requireDocId(event)
  const session = await getValidatedUserSession(event)
  const config = useRuntimeConfig()

  if (!config.jwtSecret) {
    throw createError({ statusCode: 500, message: 'JWT secret not configured' })
  }

  const row = await getDocWithActorRole(docId, session?.user?.id ?? null)
  if (!row) {
    // 404 rather than an anonymous token for a nonexistent doc: (a) prevents
    // "token shape" info-disclosure; (b) avoids a wasted sync-server connect
    // attempt; (c) gives the client a clear error to display.
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  const doc: DocState = {
    ownerId: row.ownerId,
    workspaceId: row.workspaceId,
    accessMode: row.accessMode
  }
  const actor: ActorState = {
    userId: session?.user?.id ?? null,
    workspaceRole: row.workspaceRole
  }

  const decision = decideTokenAccess(doc, actor)
  const responseBase = {
    readOnly: decision.readOnly,
    accessMode: row.accessMode,
    ownerId: row.ownerId,
    theme: row.theme
  }

  if (decision.outcome === 'forbidden') {
    return { token: null, requiresPassword: false, forbidden: true, ...responseBase }
  }
  if (decision.outcome === 'password-required') {
    return { token: null, requiresPassword: true, forbidden: false, ...responseBase }
  }

  const token = jwt.sign(
    {
      docId,
      userId: session?.user?.id || 'anonymous',
      // Carried so the sync-server can attribute edits reliably without
      // guessing from awareness (a cursor move by User A can otherwise
      // steal attribution from a real edit by User B). Anonymous users
      // end up with null here; the sync-server falls back to awareness.
      userName: session?.user?.name ?? null,
      readOnly: decision.readOnly
    },
    config.jwtSecret,
    { expiresIn: '2h' }
  )

  return { token, requiresPassword: false, forbidden: false, ...responseBase }
})
