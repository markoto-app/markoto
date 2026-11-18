import type { z } from 'zod'
import { listScopeDocs, type DocListRow } from '../../repos/documents'
import { folderSubtreeIds, getFolder, listFolders, type FolderScope } from '../../repos/folders'
import { searchDocuments } from '../../repos/documentSearch'
import { listWorkspacesForUser } from '../../repos/workspaces'
import type { UserScope, WorkspaceAccess } from '../../repos/proofs'
import { proveWorkspaceAccess } from '../access/workspaceAccess'
import { apiError } from '../api/apiError'
import { decodeDocCursor, encodeDocCursor } from './docCursor'
import { prefixTsQuery } from '~~/shared/utils/documents/searchQuery'
import type { docListQuery } from '~~/shared/api/explorer'

// The explorer's document lists and searches, shared by the workspace and
// the personal routes, the AI tools and MCP. One row shape everywhere.

export interface DocListItem {
  docId: string
  title: string
  description: string
  language: string
  accessMode: string
  wordCount: number
  folderId: string | null
  ownerId: number | null
  ownerName: string | null
  isOwner: boolean
  createdAt: string
  updatedAt: string
  lastActive: string
  /** Search mode: the body excerpt around the matches (markers from `shared/utils/documents/searchQuery.ts`). */
  snippet?: string
}

export interface DocListPage {
  items: DocListItem[]
  total: number
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null
}

const iso = (d: Date) => d.toISOString()

function toItem(r: DocListRow): DocListItem {
  return {
    docId: r.docId,
    title: r.title,
    description: r.description,
    language: r.language,
    accessMode: r.accessMode,
    wordCount: r.wordCount ?? 0,
    folderId: r.folderId,
    ownerId: r.ownerId,
    ownerName: r.ownerName,
    isOwner: r.isOwner,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    lastActive: iso(r.lastActive)
  }
}

/** A page of a scope's documents: a folder's, the root's or all of them; ranked search when `q` is given. */
export async function listDocsPage(self: UserScope, scope: FolderScope, query: z.output<typeof docListQuery>): Promise<DocListPage> {
  const folder = query.folder === 'root' ? null : query.folder
  if (folder !== null && folder !== 'all' && !(await getFolder(scope, folder))) throw apiError('folder/not-found')

  if (query.q) {
    // Search: the folder and its subfolders (or the whole scope), ranked.
    const offset = Number.parseInt(query.cursor ?? '0', 10) || 0
    const folderIds = folder === null || folder === 'all' ? undefined : await folderSubtreeIds(scope, folder)
    const isWorkspace = 'workspaceId' in scope
    const hits = await searchDocuments(self, {
      workspaces: isWorkspace ? [scope] : [],
      personal: !isWorkspace,
      shared: false,
      folderIds
    }, { tsQuery: prefixTsQuery(query.q), raw: query.q, limit: query.limit + 1, offset })
    const page = hits.slice(0, query.limit)
    const rows = new Map((await listScopeDocs(scope, { folder: 'all', docIds: page.map(h => h.docId), sort: 'updated', dir: 'desc', limit: page.length + 1 })).rows.map(r => [r.docId, r]))
    return {
      items: page.flatMap((h) => {
        const r = rows.get(h.docId)
        return r ? [{ ...toItem(r), snippet: h.snippet }] : []
      }),
      total: offset + hits.length,
      nextCursor: hits.length > query.limit ? String(offset + query.limit) : null
    }
  }

  const after = decodeDocCursor(query.cursor)
  if (query.cursor && !after) throw apiError('request/invalid', { field: 'cursor' })
  const dir = query.dir ?? (query.sort === 'title' ? 'asc' : 'desc')
  const { rows, total } = await listScopeDocs(scope, {
    folder,
    sort: query.sort,
    dir,
    ownerId: query.owner,
    after: after ?? undefined,
    limit: query.limit + 1
  })
  const page = rows.slice(0, query.limit)
  const last = page.at(-1)
  return {
    items: page.map(toItem),
    total,
    nextCursor: rows.length > query.limit && last ? encodeDocCursor(last.sortKey, last.docId) : null
  }
}

/** The folders of a scope for the tree. */
export async function folderTree(scope: FolderScope) {
  const rows = await listFolders(scope)
  return rows.map(r => ({ folderId: r.folderId, parentId: r.parentId, name: r.name, docCount: r.docCount, updatedAt: iso(r.updatedAt) }))
}

/**
 * Proofs for every workspace the user is a member of (SSO-checked: a
 * workspace that enforces single sign-on without a current sign-in is left
 * out). Guests hold none.
 */
export async function memberWorkspaceProofs(self: UserScope): Promise<Array<WorkspaceAccess<'member'>>> {
  const out: Array<WorkspaceAccess<'member'>> = []
  for (const ws of await listWorkspacesForUser(self)) {
    const proof = await proveWorkspaceAccess(self.userId, ws.workspaceId, 'member')
    if (proof) out.push(proof)
  }
  return out
}
