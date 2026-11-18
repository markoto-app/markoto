import type { z } from 'zod'
import { nanoid } from 'nanoid'
import { createFolder, folderDeletePlan, folderPath, folderSubtreeIds, getFolder, moveFolder, renameFolder } from '../../repos/folders'
import { appendAuditEvent } from '../../repos/audit'
import { ConflictError, DuplicateError, NotFoundError } from '../../repos/errors'
import { searchDocuments } from '../../repos/documentSearch'
import { listWorkspacesForUser } from '../../repos/workspaces'
import type { UserScope } from '../../repos/proofs'
import { proveFolderScope, type FolderScopeProof } from '../access/folderProof'
import { apiError } from '../api/apiError'
import { memberWorkspaceProofs } from '../access/workspaceAccess'
import { FOLDER_MAX_DEPTH } from '~~/shared/config/imports'
import { prefixTsQuery } from '~~/shared/utils/documents/searchQuery'
import type { documentSearchQuery, updateFolderBody } from '~~/shared/api/explorer'

// Folder use cases behind the explorer routes, plus the global document search.

interface Actor { userId: number, ip: string | null }

/** Repo errors of the folder repos as API errors. */
function folderError(e: unknown): never {
  if (e instanceof DuplicateError) throw apiError('folder/name-taken')
  if (e instanceof ConflictError && e.message === 'folder-cycle') throw apiError('folder/cycle')
  if (e instanceof ConflictError && e.message === 'folder-too-deep') throw apiError('folder/too-deep', { max: FOLDER_MAX_DEPTH })
  if (e instanceof NotFoundError) throw apiError('folder/not-found')
  throw e
}

function auditScope(proof: FolderScopeProof<'member'>, userId: number): { scope: 'workspace' | 'user', scopeId: string, workspaceId: string | null } {
  return proof.kind === 'workspace'
    ? { scope: 'workspace', scopeId: proof.workspaceId, workspaceId: proof.workspaceId }
    : { scope: 'user', scopeId: String(userId), workspaceId: null }
}

export async function createFolderInScope(proof: FolderScopeProof<'editor'>, actor: Actor, name: string, parentId: string | null) {
  try {
    const folder = await createFolder(proof.scope, { folderId: nanoid(12), name, parentId })
    await appendAuditEvent({
      by: proof.scope,
      actorIp: actor.ip,
      ...auditScope(proof, actor.userId),
      action: 'folder.created',
      metadata: { folderId: folder.folderId, name, parentId }
    })
    return { folderId: folder.folderId, parentId: folder.parentId, name: folder.name, docCount: 0, updatedAt: folder.updatedAt.toISOString() }
  } catch (e) {
    folderError(e)
  }
}

export async function updateFolder(actor: Actor, folderId: string, body: z.output<typeof updateFolderBody>) {
  const proof = await proveFolderScope(actor.userId, folderId, 'editor')
  if (!proof) throw apiError('folder/not-found')
  try {
    if (body.name !== undefined) {
      const { before } = await renameFolder(proof.scope, folderId, body.name)
      if (before !== body.name) {
        await appendAuditEvent({
          by: proof.scope,
          actorIp: actor.ip,
          ...auditScope(proof, actor.userId),
          action: 'folder.renamed',
          before: { name: before },
          after: { name: body.name },
          metadata: { folderId }
        })
      }
    }
    if (body.parentId !== undefined) {
      const { before } = await moveFolder(proof.scope, folderId, body.parentId)
      if (before !== body.parentId) {
        await appendAuditEvent({
          by: proof.scope,
          actorIp: actor.ip,
          ...auditScope(proof, actor.userId),
          action: 'folder.moved',
          before: { parentId: before },
          after: { parentId: body.parentId },
          metadata: { folderId }
        })
      }
    }
  } catch (e) {
    folderError(e)
  }
  const folder = await getFolder(proof.scope, folderId)
  if (!folder) throw apiError('folder/not-found')
  return { folderId: folder.folderId, parentId: folder.parentId, name: folder.name, updatedAt: folder.updatedAt.toISOString() }
}

/** Counts for the delete confirmation: what goes, and what the caller may not delete. */
export async function folderDeletePreview(userId: number, folderId: string) {
  const proof = await proveFolderScope(userId, folderId, 'editor')
  if (!proof) throw apiError('folder/not-found')
  const plan = await folderDeletePlan(proof.scope, folderId)
  if (!plan) throw apiError('folder/not-found')
  return { folders: plan.folderIds.length, documents: plan.docIds.length, blocked: plan.blockedDocs }
}

/** A folder's ancestors (root first) and its scope, for breadcrumbs. */
export async function folderBreadcrumb(userId: number, folderId: string) {
  const proof = await proveFolderScope(userId, folderId, 'member')
  if (!proof) throw apiError('folder/not-found')
  const path = await folderPath(proof.scope, folderId)
  if (path.length === 0) throw apiError('folder/not-found')
  return { workspaceId: proof.workspaceId, path }
}

/**
 * The global search: personal documents, every workspace the caller is a
 * member of (SSO-checked), and documents shared with them as a guest; or
 * one of those scopes. Each hit names its workspace.
 */
export async function searchEverywhere(self: UserScope, query: z.output<typeof documentSearchQuery>) {
  const workspaces = await memberWorkspaceProofs(self)
  const scope = query.scope
  const selected = scope === 'all' || scope === 'personal' ? workspaces : workspaces.filter(w => `ws:${w.workspaceId}` === scope)
  if (scope.startsWith('ws:') && selected.length === 0) throw apiError('workspace/not-found')
  let folderIds: string[] | undefined
  if (query.folder) {
    const proof = await proveFolderScope(self.userId, query.folder, 'member')
    if (!proof || (scope.startsWith('ws:') ? `ws:${proof.workspaceId}` !== scope : proof.kind !== 'personal')) throw apiError('folder/not-found')
    folderIds = await folderSubtreeIds(proof.scope, query.folder)
  }
  const hits = await searchDocuments(self, {
    workspaces: scope === 'personal' ? [] : selected,
    personal: scope === 'all' || scope === 'personal',
    shared: scope === 'all',
    folderIds
  }, { tsQuery: prefixTsQuery(query.q), raw: query.q, limit: query.limit + 1, offset: query.offset })
  const names = new Map((await listWorkspacesForUser(self)).map(w => [w.workspaceId, w.name]))
  return {
    results: hits.slice(0, query.limit).map(h => ({
      docId: h.docId,
      title: h.title,
      workspaceId: h.workspaceId,
      workspaceName: h.workspaceId ? names.get(h.workspaceId) ?? null : null,
      folderId: h.folderId,
      updatedAt: h.updatedAt.toISOString(),
      snippet: h.snippet
    })),
    hasMore: hits.length > query.limit
  }
}
