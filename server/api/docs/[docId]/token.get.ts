import jwt from 'jsonwebtoken'
import { and, eq } from 'drizzle-orm'
import { documents, workspaceMembers } from '../../../db/schema'
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
  const db = useDatabase()
  const config = useRuntimeConfig()

  if (!config.jwtSecret) {
    throw createError({ statusCode: 500, message: 'JWT secret not configured' })
  }

  const docRow = (await db
    .select({
      accessMode: documents.accessMode,
      ownerId: documents.ownerId,
      theme: documents.theme,
      workspaceId: documents.workspaceId
    })
    .from(documents)
    .where(eq(documents.docId, docId))
    .limit(1))[0]

  if (!docRow) {
    // 404 rather than an anonymous token for a nonexistent doc: (a) prevents
    // "token shape" info-disclosure; (b) avoids a wasted sync-server connect
    // attempt; (c) gives the client a clear error to display.
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  // Second query, gated on (a) logged in and (b) doc has a workspace.
  // Kept separate from the doc fetch to avoid awkward LEFT JOIN semantics
  // for the anon / no-workspace cases.
  let workspaceRole: 'admin' | 'editor' | 'viewer' | null = null
  if (docRow.workspaceId && typeof session?.user?.id === 'number') {
    const memberRow = (await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceId, docRow.workspaceId),
        eq(workspaceMembers.userId, session.user.id)
      ))
      .limit(1))[0]
    workspaceRole = (memberRow?.role ?? null) as typeof workspaceRole
  }

  const doc: DocState = {
    ownerId: docRow.ownerId,
    workspaceId: docRow.workspaceId,
    accessMode: docRow.accessMode
  }
  const actor: ActorState = {
    userId: session?.user?.id ?? null,
    workspaceRole
  }

  const decision = decideTokenAccess(doc, actor)
  const responseBase = {
    readOnly: decision.readOnly,
    accessMode: docRow.accessMode,
    ownerId: docRow.ownerId,
    theme: docRow.theme
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
