import { z } from 'zod'
import { defineMetaTool, toolError, toolOk, type ToolResult } from './toolDefinition'
import type { MetaToolContext } from '../../agentic/toolContext'
import type { FolderScope } from '../../../repos/folders'
import { proveFolderScope, proveScope, type FolderNeed, type FolderScopeProof } from '../../access/folderProof'
import { folderTree } from '../../explorer/docLists'
import { createFolderInScope } from '../../explorer/folderActions'
import { moveDocsToFolder } from '../../explorer/bulkActions'
import { folderName } from '~~/shared/api/explorer'
import { parseDocIdFromInput } from './docRef'

// Folders for the AI loop and MCP: list a scope's folders, create one, file
// a document into one. A scope is a workspace (through the caller's role
// there, SSO-checked; guests have none) or the caller's personal documents.
// Every decision is the explorer's own (`server/utils/explorer/`), so the
// tools can never do more than the caller could in the document list.

/** The `workspace_id` value that names the caller's personal documents. */
export const PERSONAL_SCOPE = 'personal'

/** Folder listings longer than this are cut (a tree that big is not read by a model anyway). */
const LIST_FOLDERS_MAX = 500

const WorkspaceArg = z.string().trim().min(1).max(64)

export const ListFoldersArgs = z.object({
  workspace_id: WorkspaceArg.optional()
    .describe('A workspace id, or "personal" for your personal (non-workspace) documents. Omit for the current document\'s workspace (personal folders when the current document is not in a workspace).')
}).describe('List the folders of a workspace or of your personal documents: folder_id, full path, parent and the number of documents filed directly in it.')

export const CreateFolderArgs = z.object({
  workspace_id: WorkspaceArg.optional()
    .describe('A workspace id, or "personal" for your personal documents. Omit to use the parent folder\'s scope, else the current document\'s workspace (personal when it is not in one). You must be an editor or admin of the workspace.'),
  name: folderName.describe('Folder name, 1 to 120 characters, no slashes. Unique among its siblings (case-insensitive).'),
  parent_id: z.string().trim().min(1).max(64).optional()
    .describe('The folder to create it in (an id from list_folders). Omit for the top level.')
}).describe('Create a folder in a workspace or in your personal documents. Returns its folder_id.')

export const MoveDocumentArgs = z.object({
  doc_id: z.string().trim().min(1).max(2048)
    .describe('The document to move: its id or a markoto URL containing it.'),
  folder_id: z.string().trim().min(1).max(64).nullable()
    .describe('The target folder (an id from list_folders, in the document\'s own workspace or personal documents), or null for the top level.')
}).describe('File a document into a folder of its own workspace (or of your personal documents), or back to the top level. Needs edit rights on the document. Does not move documents between workspaces.')

/** An HTTP error the explorer threw on purpose (4xx), as a tool error; anything else is a bug and propagates. */
export function explorerErrorAsToolResult(e: unknown): ToolResult {
  const status = (e as { statusCode?: unknown } | null)?.statusCode
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return toolError(`Error: ${(e as Error).message}`)
  }
  throw e
}

/**
 * The folder scope a tool's `workspace_id` names, at `need`: "personal", a
 * workspace id, or (omitted) the current document's workspace, personal
 * when the context has none. Null when the caller lacks the role.
 */
async function scopeFor<N extends FolderNeed>(ctx: MetaToolContext, workspaceId: string | undefined, need: N): Promise<FolderScopeProof<N> | null> {
  if (workspaceId === PERSONAL_SCOPE) return proveScope(ctx.initiatorUserId, null, need)
  if (workspaceId !== undefined) return proveScope(ctx.initiatorUserId, workspaceId, need)
  return proveScope(ctx.initiatorUserId, ctx.workspaceAccess?.workspaceId ?? null, need)
}

/**
 * The workspace of a folder the user may read: its id, null for one of
 * their personal folders, undefined when the folder is unknown to them.
 */
export async function folderWorkspace(userId: number, folderId: string): Promise<string | null | undefined> {
  const proof = await proveFolderScope(userId, folderId, 'member')
  return proof ? proof.workspaceId : undefined
}

/** Folder id → its path ("Projects / 2026 / Q3") for one scope's folders. */
export async function folderPathsOf(scope: FolderScope): Promise<(folderId: string | null) => string | null> {
  const byId = new Map((await folderTree(scope)).map(f => [f.folderId, f]))
  const cache = new Map<string, string>()
  return (folderId) => {
    if (folderId === null) return null
    const known = cache.get(folderId)
    if (known !== undefined) return known
    const names: string[] = []
    // Bounded walk: a corrupt parent cycle can't loop.
    for (let id: string | null = folderId, hops = 0; id !== null && hops < 64; hops++) {
      const f = byId.get(id)
      if (!f) break
      names.unshift(f.name)
      id = f.parentId
    }
    const path = names.length > 0 ? names.join(' / ') : null
    if (path !== null) cache.set(folderId, path)
    return path
  }
}

/**
 * Paths of folders across several scopes (search hits come from many):
 * one tree per scope, loaded on first use. Workspaces the user reaches only
 * as a guest have no readable folders, so their hits get no path.
 */
export function folderPathsAcrossScopes(ctx: MetaToolContext): (workspaceId: string | null, folderId: string | null) => Promise<string | null> {
  const trees = new Map<string, Promise<((id: string | null) => string | null) | null>>()
  return async (workspaceId, folderId) => {
    if (folderId === null) return null
    const key = workspaceId ?? ''
    let tree = trees.get(key)
    if (!tree) {
      tree = proveScope(ctx.initiatorUserId, workspaceId, 'member').then(p => (p ? folderPathsOf(p.scope) : null))
      trees.set(key, tree)
    }
    const resolve = await tree
    return resolve ? resolve(folderId) : null
  }
}

async function handleListFolders(ctx: MetaToolContext, input: z.output<typeof ListFoldersArgs>): Promise<ToolResult> {
  const proof = await scopeFor(ctx, input.workspace_id, 'member')
  if (!proof) return toolError(`Error: workspace "${input.workspace_id}" not found, or you are not a member of it.`)
  const folders = await folderTree(proof.scope)
  const pathOf = await folderPathsOf(proof.scope)
  const shown = folders.slice(0, LIST_FOLDERS_MAX)
  return toolOk(JSON.stringify({
    scope: proof.kind,
    workspace_id: proof.workspaceId,
    total: folders.length,
    folders: shown.map(f => ({ folder_id: f.folderId, path: pathOf(f.folderId), parent_id: f.parentId, documents: f.docCount })),
    notes: [
      folders.length > shown.length ? `Only the first ${shown.length} folders are shown.` : null,
      'Pass folder_id to list_workspace_documents / list_my_documents, search_documents, move_document or create_document.',
      'documents counts only documents filed directly in the folder, not in its subfolders.'
    ].filter(Boolean)
  }, null, 2))
}

async function handleCreateFolder(ctx: MetaToolContext, input: z.output<typeof CreateFolderArgs>): Promise<ToolResult> {
  const actor = { userId: ctx.initiatorUserId, ip: null }
  let proof: FolderScopeProof<'editor'> | null
  if (input.parent_id !== undefined) {
    proof = await proveFolderScope(ctx.initiatorUserId, input.parent_id, 'editor')
    const wanted = input.workspace_id === PERSONAL_SCOPE ? null : input.workspace_id
    if (!proof || (input.workspace_id !== undefined && proof.workspaceId !== wanted)) {
      return toolError(`Error: parent folder "${input.parent_id}" not found, or you can't create folders there.`)
    }
  } else {
    proof = await scopeFor(ctx, input.workspace_id, 'editor')
    if (!proof) return toolError('Error: workspace not found, or you need the editor or admin role in it to create folders.')
  }
  try {
    const folder = await createFolderInScope(proof, actor, input.name, input.parent_id ?? null)
    const pathOf = await folderPathsOf(proof.scope)
    return toolOk(JSON.stringify({
      folder_id: folder.folderId,
      path: pathOf(folder.folderId),
      parent_id: folder.parentId,
      workspace_id: proof.workspaceId
    }, null, 2))
  } catch (e) {
    return explorerErrorAsToolResult(e)
  }
}

const MOVE_REFUSALS: Readonly<Record<string, string>> = {
  'docs/edit-forbidden': 'not found, or you can\'t edit it',
  'folder/not-found': 'can\'t go there: the folder doesn\'t exist in the document\'s own workspace (or personal documents)'
}

async function handleMoveDocument(ctx: MetaToolContext, input: z.output<typeof MoveDocumentArgs>): Promise<ToolResult> {
  const docId = parseDocIdFromInput(input.doc_id)
  if (!docId) return toolError(`Error: could not extract a document id from "${input.doc_id.slice(0, 80)}".`)
  const [result] = await moveDocsToFolder({ userId: ctx.initiatorUserId, ip: null }, [docId], input.folder_id)
  if (!result?.ok) {
    const why = MOVE_REFUSALS[result?.code ?? ''] ?? `was not moved (${result?.code ?? 'unknown error'})`
    return toolError(`Error: document "${docId}" ${why}.`)
  }
  const path = input.folder_id === null ? null : await folderPathsAcrossScopes(ctx)(await folderWorkspace(ctx.initiatorUserId, input.folder_id) ?? null, input.folder_id)
  return toolOk(JSON.stringify({ doc_id: docId, folder_id: input.folder_id, folder: path ?? (input.folder_id === null ? '(top level)' : null) }, null, 2))
}

export const listFoldersTool = defineMetaTool({
  name: 'list_folders',
  description: 'List the folders of a workspace or of your personal documents, with each folder\'s id, full path ("Projects / 2026"), parent and how many documents are filed directly in it. Omit workspace_id for the current document\'s workspace; "personal" for your personal documents. Use before move_document, create_folder or a folder-filtered list or search.',
  schema: ListFoldersArgs,
  trustBoundary: 'confirm',
  handler: handleListFolders
})

export const createFolderTool = defineMetaTool({
  name: 'create_folder',
  description: 'Create a folder in a workspace (you need the editor or admin role) or in your personal documents, at the top level or inside parent_id. Returns the new folder_id and its path. Only create folders the user asked for.',
  schema: CreateFolderArgs,
  trustBoundary: 'confirm',
  handler: handleCreateFolder
})

export const moveDocumentTool = defineMetaTool({
  name: 'move_document',
  description: 'File a document into a folder (folder_id from list_folders) or back to the top level (folder_id null). The folder must belong to the document\'s own workspace, or to your personal documents for a personal document. Needs edit rights on the document. Only move documents the user asked you to organise.',
  schema: MoveDocumentArgs,
  trustBoundary: 'confirm',
  handler: handleMoveDocument
})
