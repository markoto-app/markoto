import { getDocWithActorRole } from '../../../repos/documents'
import { listRecentActivity } from '../../../repos/activity'
import { decideActivityAccess, type DocState, type ActorState } from '../../../../shared/utils/docPermissions'
import { hasValidDocJwt } from '../../../utils/docTokenVerify'

// Activity log is a view-level read. Rules mirror file access:
//   - open-edit / open-view → public.
//   - private / password-protected → owner, workspace member, or
//     holder of a valid doc-scoped JWT (covers anon users who verified
//     a password and got a JWT back from /password).

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)
  const session = await getValidatedUserSession(event)

  const row = await getDocWithActorRole(docId, session?.user?.id ?? null)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  const doc: DocState = {
    ownerId: row.ownerId,
    workspaceId: row.workspaceId,
    accessMode: row.accessMode
  }
  const actor: ActorState = {
    userId: session?.user?.id ?? null,
    workspaceRole: row.workspaceRole,
    hasValidDocJwt: hasValidDocJwt(event, docId)
  }

  const decision = decideActivityAccess(doc, actor)
  if (decision.outcome === 'deny') {
    throw createError({ statusCode: 403, message: 'Access denied' })
  }

  return listRecentActivity(docId, 50)
})
