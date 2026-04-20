import { deleteDocument } from '../../../utils/documentLifecycle'

// Delete a document. Allowed for:
//   - the doc's owner (creator), always,
//   - a workspace admin of the doc's workspace (they can delete anyone's doc
//     in their workspace).
// Workspace editors and viewers cannot delete docs they don't own — an
// editor who created the doc is covered by the "owner" path above.
// Authz is centralized in `canManageDoc`; `deleteDocument` itself trusts its
// input and is also called from the inactive-doc sweeper (no session).

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const docId = requireDocId(event)

  const authz = await getDocAuthz(session.user.id, docId)
  if (!authz.exists) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }
  if (!authz.canManage) {
    throw createError({ statusCode: 403, message: 'Not authorized to delete this document' })
  }

  await deleteDocument(docId)
  return { success: true }
})
