import { and, eq } from 'drizzle-orm'
import { documents, workspaceMembers } from '../../../db/schema'
import { deleteDocument } from '../../../utils/documentLifecycle'
import { decideDocDelete, type DocState, type ActorState } from '../../../../shared/utils/docPermissions'

// Delete a document. Authorisation is decided by `decideDocDelete`:
//   - anonymous doc (no owner, no workspace) → anyone may delete, even an
//     anonymous caller. No persistent identity to scope the right to, so
//     "anyone with edit access" is the closest approximation. Anon docs
//     are always open-edit, so edit access = view access = everyone.
//   - owned standalone doc → owner only.
//   - workspace doc → owner or workspace admin.
// `deleteDocument` itself trusts its input (it's also called from the
// inactive-doc sweeper without a session).

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)

  // Modest brake on anonymous-delete. Aligned with the token endpoint
  // (30/min) — deletes are rarer, so 10/min per IP is plenty.
  const ip = getRequestHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
    || getRequestHeader(event, 'x-real-ip')
    || 'unknown'
  if (!(await checkRateLimit('doc-delete', ip, 10, 60_000))) {
    throw createError({ statusCode: 429, message: 'Too many delete requests. Try again later.' })
  }

  const db = useDatabase()
  const docRow = (await db
    .select({
      accessMode: documents.accessMode,
      ownerId: documents.ownerId,
      workspaceId: documents.workspaceId
    })
    .from(documents)
    .where(eq(documents.docId, docId))
    .limit(1))[0]

  if (!docRow) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  // Session is optional here — anon can reach this endpoint to delete an
  // anon doc. `getValidatedUserSession` still clears stale cookies as a
  // side effect, which is fine.
  const session = await getValidatedUserSession(event)

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

  const decision = decideDocDelete(doc, actor)
  if (decision.outcome === 'deny') {
    if (decision.reason === 'authentication-required') {
      throw createError({ statusCode: 401, message: 'Login required' })
    }
    throw createError({ statusCode: 403, message: 'Not authorized to delete this document' })
  }

  await deleteDocument(docId)
  return { success: true }
})
