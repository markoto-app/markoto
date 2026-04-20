import jwt from 'jsonwebtoken'
import { and, eq } from 'drizzle-orm'
import { documents, workspaceMembers } from '../../../db/schema'

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

  const doc = (await db
    .select({
      accessMode: documents.accessMode,
      ownerId: documents.ownerId,
      theme: documents.theme,
      workspaceId: documents.workspaceId
    })
    .from(documents)
    .where(eq(documents.docId, docId))
    .limit(1))[0]

  // Workspace-membership lookup is a second query gated on (a) logged in
  // and (b) doc has a workspace. Kept separate from the doc fetch to avoid
  // awkward LEFT JOIN semantics for the anon / no-workspace cases.
  let workspaceRole: 'admin' | 'editor' | 'viewer' | null = null
  if (doc && doc.workspaceId && typeof session?.user?.id === 'number') {
    const memberRow = (await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceId, doc.workspaceId),
        eq(workspaceMembers.userId, session.user.id)
      ))
      .limit(1))[0]
    workspaceRole = (memberRow?.role ?? null) as any
  }

  if (!doc) {
    // Previously we fell through and minted a JWT for a nonexistent doc.
    // That's an info-disclosure primitive (token shape proves the endpoint
    // works) and wastes a sync-server connection attempt. 404 is the honest
    // answer and keeps the client from spinning in "connecting" forever.
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  let readOnly = false
  let requiresPassword = false
  let forbidden = false
  const accessMode = doc.accessMode
  const ownerId = doc.ownerId

  const userId = session?.user?.id
  const isOwner = ownerId != null && typeof userId === 'number' && ownerId === userId
  const wsRole = workspaceRole

  // Admin / editor of the doc's workspace is treated like the owner for
  // access purposes (bypasses private, full edit). Viewer bypasses private
  // too but stays read-only. Non-members fall through to the accessMode
  // rules below — i.e. standalone and anonymous docs are untouched.
  const isWorkspaceEditor = wsRole === 'admin' || wsRole === 'editor'
  const isWorkspaceViewer = wsRole === 'viewer'
  const hasOwnerEquivalentAccess = isOwner || isWorkspaceEditor
  const hasAnyWorkspaceAccess = hasOwnerEquivalentAccess || isWorkspaceViewer

  if (doc.accessMode === 'private' && !hasAnyWorkspaceAccess) {
    // No token — same pattern as password-protected. Hocuspocus rejects the
    // connection so no content leaks. The client shows a private-document
    // lock screen with a prompt to log in or contact the owner.
    forbidden = true
    readOnly = true
  }

  if (doc.accessMode === 'open-view' && !hasOwnerEquivalentAccess) {
    readOnly = true
  }

  if (doc.accessMode === 'password-protected' && !hasOwnerEquivalentAccess) {
    requiresPassword = true
    readOnly = true
  }

  // Viewers of a workspace are always read-only regardless of accessMode —
  // including when the doc is open-edit (workspace role is more restrictive
  // than the public accessMode in that case, and must win).
  if (isWorkspaceViewer && !isOwner) {
    readOnly = true
  }

  // No-token exits: private (no path to unlock from the client) and
  // password-protected (unlocked after /password verify).
  if (forbidden || requiresPassword) {
    return { token: null, readOnly, requiresPassword, forbidden, accessMode, ownerId, theme: doc.theme }
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

  return { token, readOnly, requiresPassword, forbidden: false, accessMode, ownerId, theme: doc.theme }
})
