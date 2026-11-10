import { collectBrandObjectKeys, deleteBrandObjects } from '../../../utils/brandKit/storage'
import { deleteWorkspaceRow } from '../../../repos/workspaces'
import { getDoc, listDocIdsInWorkspace } from '../../../repos/documents'
import { listKnowledge } from '../../../repos/knowledge'
import { deleteDocument } from '../../../utils/documentLifecycle'
import { deleteKnowledgeArtifact } from '../../../utils/knowledgeAccess'
import { appendAuditEvent } from '../../../repos/audit'
import { endWorkspaceBilling } from '../../../utils/workspaceBillingLifecycle'

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

  const role = await getWorkspaceRole(session.user.id, wsId)
  if (role === null) throw createError({ statusCode: 404, message: 'Workspace not found' })
  if (role !== 'admin') {
    throw createError({ statusCode: 403, message: 'Only admins can delete the workspace' })
  }

  const ip = getClientIp(event)

  // Team / Business (WP3): cancel the subscription first (annual:
  // prorated credit) and delete the workspace's LiteLLM team. If Stripe
  // can't cancel it, this throws and nothing has been deleted yet.
  await endWorkspaceBilling(wsId, session.user.id)

  const childDocIds = await listDocIdsInWorkspace(wsId)
  for (const docId of childDocIds) {
    // Snapshot per-doc before the cascade for audit forensics.
    const snapshot = await getDoc(docId)
    await deleteDocument(docId)
    await appendAuditEvent({
      actorUserId: session.user.id,
      actorIp: ip,
      scope: 'doc',
      scopeId: docId,
      action: 'doc.deleted',
      workspaceId: wsId,
      before: snapshot
        ? {
            title: snapshot.title,
            accessMode: snapshot.accessMode,
            ownerId: snapshot.ownerId,
            workspaceId: snapshot.workspaceId
          }
        : null,
      after: null,
      metadata: { reason: 'workspace_cascade', workspaceId: wsId }
    })
  }

  // Knowledge S3 cleanup is per-object (one key per row) — the FK on
  // workspace_knowledge → workspaces cascades the DB row automatically,
  // but S3 objects are orphaned without this explicit sweep.
  const knowledgeRows = await listKnowledge(wsId)
  for (const row of knowledgeRows) {
    await deleteKnowledgeArtifact(row.knowledgeId)
  }

  // Brand-kit objects (WP10): the rows cascade with the workspace; read
  // their keys first, delete the objects after.
  const brandKeys = await collectBrandObjectKeys(wsId)

  // workspace_members rows are removed automatically by the ON DELETE
  // CASCADE foreign key.
  await deleteWorkspaceRow(wsId)
  await deleteBrandObjects(brandKeys)

  await appendAuditEvent({
    actorUserId: session.user.id,
    actorIp: ip,
    scope: 'workspace',
    scopeId: wsId,
    action: 'workspace.deleted',
    before: null,
    after: null,
    metadata: { deletedDocs: childDocIds.length, deletedKnowledge: knowledgeRows.length }
  })

  return { success: true, deletedDocs: childDocIds.length, deletedKnowledge: knowledgeRows.length }
})
