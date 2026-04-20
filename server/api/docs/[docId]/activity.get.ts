import { and, desc, eq } from 'drizzle-orm'
import { activityLog, documents, workspaceMembers } from '../../../db/schema'
import { decideActivityAccess, type DocState, type ActorState } from '../../../../shared/utils/docPermissions'
import { hasValidDocJwt } from '../../../utils/docTokenVerify'

// Activity log is a view-level read. Rules mirror file access:
//   - open-edit / open-view → public.
//   - private / password-protected → owner, workspace member, or
//     holder of a valid doc-scoped JWT (covers anon users who verified
//     a password and got a JWT back from /password).

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)
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
    workspaceRole,
    hasValidDocJwt: hasValidDocJwt(event, docId)
  }

  const decision = decideActivityAccess(doc, actor)
  if (decision.outcome === 'deny') {
    throw createError({ statusCode: 403, message: 'Access denied' })
  }

  const entries = await db.select()
    .from(activityLog)
    .where(eq(activityLog.docId, docId))
    .orderBy(desc(activityLog.createdAt))
    .limit(50)

  return entries
})
