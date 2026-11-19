import { moveDocToFolder, moveFolder, folderDeletePlan, deleteFolderRow, getFolder } from '../../repos/folders'
import { getDocForDeletion } from '../../repos/documents'
import { appendAuditEvent } from '../../repos/audit'
import { isRepoError, NotFoundError, ConflictError, DuplicateError } from '../../repos/errors'
import type { DocAccess } from '../../repos/proofs'
import { proveDocMembership, proveDocNeed } from '../access/docProof'
import { proveFolderScope, type FolderScopeProof } from '../access/folderProof'
import { deleteDocuments } from '../documents/documentLifecycle'
import { moveDocumentToWorkspace } from '../documents/workspaceMove'
import type { SecondObjectProver } from '../api/policyProver'
import { apiError } from '../api/apiError'

// The explorer's actions on several items at once. Each item is decided on
// its own, exactly like the single-item route would decide it, and gets its
// own result (partial success): one document the caller may not move never
// blocks the others. Every change is audited per item.

export interface BulkItemResult {
  id: string
  kind: 'doc' | 'folder'
  ok: boolean
  /** Why it was refused (an API error code), when `ok` is false. */
  code?: string
}

interface Actor { userId: number, ip: string | null }

function codeOf(e: unknown, fallback: string): string {
  const data = (e as { data?: { code?: unknown } } | null)?.data
  if (data && typeof data.code === 'string') return data.code
  if (e instanceof DuplicateError) return 'folder/name-taken'
  if (e instanceof ConflictError) return e.message === 'folder-cycle' ? 'folder/cycle' : e.message === 'folder-too-deep' ? 'folder/too-deep' : fallback
  if (e instanceof NotFoundError) return e.message.startsWith('Folder') ? 'folder/not-found' : 'docs/not-found'
  return fallback
}

/** File documents into `folderId` (null = the root of each document's own scope). Needs edit rights on each. */
export async function moveDocsToFolder(actor: Actor, docIds: readonly string[], folderId: string | null): Promise<BulkItemResult[]> {
  const results: BulkItemResult[] = []
  for (const docId of docIds) {
    const proven = await proveDocMembership(actor.userId, docId, 'edit')
    if (!proven) {
      results.push({ id: docId, kind: 'doc', ok: false, code: 'docs/edit-forbidden' })
      continue
    }
    try {
      const { before } = await moveDocToFolder(proven.access, folderId)
      if (before !== folderId) {
        await appendAuditEvent({
          by: proven.access,
          actorIp: actor.ip,
          scope: 'doc',
          scopeId: docId,
          action: 'doc.folder_moved',
          workspaceId: proven.workspaceId,
          before: { folderId: before },
          after: { folderId }
        })
      }
      results.push({ id: docId, kind: 'doc', ok: true })
    } catch (e) {
      if (!isRepoError(e)) throw e
      results.push({ id: docId, kind: 'doc', ok: false, code: codeOf(e, 'folder/not-found') })
    }
  }
  return results
}

/** Move documents into another workspace (null = the caller's personal documents). Needs manage rights on each. */
export async function moveDocsToWorkspace(actor: Actor, prove: SecondObjectProver, docIds: readonly string[], workspaceId: string | null): Promise<BulkItemResult[]> {
  const results: BulkItemResult[] = []
  for (const docId of docIds) {
    const proven = await proveDocMembership(actor.userId, docId, 'manage')
    if (!proven) {
      results.push({ id: docId, kind: 'doc', ok: false, code: 'share/move-not-allowed' })
      continue
    }
    try {
      await moveDocumentToWorkspace(proven.access, proven.workspaceId, workspaceId, { prove, actorIp: actor.ip })
      results.push({ id: docId, kind: 'doc', ok: true })
    } catch (e) {
      results.push({ id: docId, kind: 'doc', ok: false, code: codeOf(e, 'auth/forbidden') })
    }
  }
  return results
}

/**
 * Delete documents the caller may delete (owner, or workspace admin), each
 * audited like a single delete. Documents they may not delete are refused
 * one by one.
 */
export async function deleteDocsBulk(actor: Actor, docIds: readonly string[], reason: { reason: 'bulk' } | { reason: 'folder_deleted', folderId: string }): Promise<BulkItemResult[]> {
  const results: BulkItemResult[] = []
  const proofs: Array<DocAccess<'delete'>> = []
  const snapshots = new Map<string, Awaited<ReturnType<typeof getDocForDeletion>>>()
  for (const docId of docIds) {
    const proof = await proveDocNeed(actor.userId, docId, 'delete')
    if (!proof) {
      results.push({ id: docId, kind: 'doc', ok: false, code: 'docs/delete-forbidden' })
      continue
    }
    snapshots.set(docId, await getDocForDeletion(proof))
    proofs.push(proof)
  }
  const deleted = new Set(await deleteDocuments(proofs))
  for (const proof of proofs) {
    const ok = deleted.has(proof.docId)
    results.push(ok ? { id: proof.docId, kind: 'doc', ok } : { id: proof.docId, kind: 'doc', ok, code: 'internal' })
    if (!ok) continue
    const snapshot = snapshots.get(proof.docId) ?? null
    await appendAuditEvent({
      by: proof,
      actorIp: actor.ip,
      scope: 'doc',
      scopeId: proof.docId,
      action: 'doc.deleted',
      workspaceId: snapshot?.workspaceId ?? null,
      before: snapshot ? { title: snapshot.title, accessMode: snapshot.accessMode, ownerId: snapshot.ownerId, workspaceId: snapshot.workspaceId } : null,
      after: null,
      metadata: reason
    })
  }
  return results
}

function folderAuditScope(proof: FolderScopeProof<'member'>, userId: number): { scope: 'workspace' | 'user', scopeId: string, workspaceId: string | null } {
  return proof.kind === 'workspace'
    ? { scope: 'workspace', scopeId: proof.workspaceId, workspaceId: proof.workspaceId }
    : { scope: 'user', scopeId: String(userId), workspaceId: null }
}

/**
 * Move folders (with their subtrees) and documents of one scope under
 * `targetFolderId` (null = the scope's root). Folders need the editor role
 * (or the owner, for personal folders); documents need edit rights.
 */
export async function bulkMove(
  actor: Actor,
  input: { workspaceId: string | null, targetFolderId: string | null, folderIds: readonly string[], docIds: readonly string[] }
): Promise<BulkItemResult[]> {
  const results: BulkItemResult[] = []
  if (input.targetFolderId !== null) {
    const target = await proveFolderScope(actor.userId, input.targetFolderId, 'member')
    if (!target || target.workspaceId !== input.workspaceId) throw apiError('folder/not-found')
  }
  for (const folderId of input.folderIds) {
    const proof = await proveFolderScope(actor.userId, folderId, 'editor')
    if (!proof || proof.workspaceId !== input.workspaceId) {
      results.push({ id: folderId, kind: 'folder', ok: false, code: 'folder/not-found' })
      continue
    }
    try {
      const { before } = await moveFolder(proof.scope, folderId, input.targetFolderId)
      if (before !== input.targetFolderId) {
        await appendAuditEvent({
          by: proof.scope,
          actorIp: actor.ip,
          ...folderAuditScope(proof, actor.userId),
          action: 'folder.moved',
          before: { parentId: before },
          after: { parentId: input.targetFolderId },
          metadata: { folderId }
        })
      }
      results.push({ id: folderId, kind: 'folder', ok: true })
    } catch (e) {
      if (!isRepoError(e)) throw e
      results.push({ id: folderId, kind: 'folder', ok: false, code: codeOf(e, 'folder/not-found') })
    }
  }
  results.push(...await moveDocsToFolder(actor, input.docIds, input.targetFolderId))
  return results
}

/**
 * Delete a folder with its subfolders and every document filed below it.
 * Refused as a whole (nothing deleted) when the caller may not delete each
 * of those documents: workspace admins may; editors only when they own
 * every one; a personal folder's owner always.
 */
export async function deleteFolderTree(actor: Actor, folderId: string): Promise<{ folders: number, documents: number }> {
  const proof = await proveFolderScope(actor.userId, folderId, 'editor')
  if (!proof) throw apiError('folder/not-found')
  const folder = await getFolder(proof.scope, folderId)
  const plan = await folderDeletePlan(proof.scope, folderId)
  if (!folder || !plan) throw apiError('folder/not-found')
  if (plan.blockedDocs > 0) throw apiError('folder/delete-blocked', { blocked: plan.blockedDocs })
  const results = await deleteDocsBulk(actor, plan.docIds, { reason: 'folder_deleted', folderId })
  const refused = results.filter(r => !r.ok).length
  // Something changed between the plan and the delete (a document moved in,
  // a role changed): keep the folder so nothing is lost silently.
  if (refused > 0) throw apiError('folder/delete-blocked', { blocked: refused })
  await deleteFolderRow(proof.scope, folderId)
  await appendAuditEvent({
    by: proof.scope,
    actorIp: actor.ip,
    ...folderAuditScope(proof, actor.userId),
    action: 'folder.deleted',
    before: { name: folder.name, parentId: folder.parentId },
    metadata: { folderId, folders: plan.folderIds.length, documents: plan.docIds.length }
  })
  return { folders: plan.folderIds.length, documents: plan.docIds.length }
}
