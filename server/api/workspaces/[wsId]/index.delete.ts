import { eq } from 'drizzle-orm'
import { workspaces, documents } from '../../../db/schema'
import { deleteDocument } from '../../../utils/documentLifecycle'

// Cascade delete: wipe every doc in this workspace (S3 + Y.js + activity
// etc via `deleteDocument`), then drop the workspace row itself. Deletes
// every doc regardless of which member created it — a workspace delete is
// a destructive admin action, not a scoped cleanup.
//
// Per-doc cascade rather than a single SQL cascade because each doc needs
// S3 cleanup and a sync-server notify — the Postgres layer can't do either.
// Sequential so a single failure surfaces immediately; workspaces are
// expected to hold tens of docs, not thousands.
//
// Admins only. Editors and viewers can't destroy the workspace; admins
// who want to leave the workspace use the member-leave endpoint instead.

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  const db = useDatabase()

  const role = await getWorkspaceRole(session.user.id, wsId)
  if (role === null) throw createError({ statusCode: 404, message: 'Workspace not found' })
  if (role !== 'admin') {
    throw createError({ statusCode: 403, message: 'Only admins can delete the workspace' })
  }

  const childDocs = await db.select({ docId: documents.docId })
    .from(documents)
    .where(eq(documents.workspaceId, wsId))

  for (const { docId } of childDocs) {
    await deleteDocument(docId)
  }

  // workspace_members rows are removed automatically by the ON DELETE
  // CASCADE foreign key.
  await db.delete(workspaces).where(eq(workspaces.workspaceId, wsId))

  return { success: true, deletedDocs: childDocs.length }
})
