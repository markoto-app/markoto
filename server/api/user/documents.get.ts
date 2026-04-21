import { listOwnedByUser } from '../../repos/documents'

// "My Documents" for the dashboard. Returns docs the caller owns. Workspace
// docs they don't own stay inside the workspace view — keeps this list
// semantically "my stuff" vs. "everything I can edit".
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const docs = await listOwnedByUser(session.user.id)
  // `isOwner: true` preserved from the previous endpoint shape so the
  // dashboard UI doesn't branch on presence.
  return docs.map(d => ({ ...d, isOwner: true as const }))
})
