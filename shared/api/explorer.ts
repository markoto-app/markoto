// Request schemas of the explorer routes: folders, paginated document lists,
// document search, bulk actions and rename (server/api/workspaces/[wsId]/
// {folders,documents}, server/api/user/{folders,personal-documents},
// server/api/folders/**, server/api/documents/bulk, server/api/search/**,
// server/api/docs/[docId]/{folder,title}). Shared with the client.
import { z } from 'zod'
import { DOC_TITLE_MAX_LENGTH } from '../config/docCreate'
import { folderNameProblem } from '../utils/documents/folderName'
import { ID_RE } from '../config/identifiers'

export const DOC_LIST_SORTS = ['updated', 'created', 'active', 'title'] as const
export type DocListSort = typeof DOC_LIST_SORTS[number]
export type SortDirection = 'asc' | 'desc'

/** Largest page of a document list, and the default. */
export const DOC_LIST_MAX_LIMIT = 200
export const DOC_LIST_DEFAULT_LIMIT = 100
/** Documents (or folders + documents) one bulk request may name. */
export const BULK_MAX_ITEMS = 200
/** Results of one search request. */
export const SEARCH_MAX_LIMIT = 50

const objectId = z.string().regex(ID_RE)

/** A folder name as typed: trimmed, 1-120 characters, no slashes or control characters. */
export const folderName = z.string().trim().superRefine((name, ctx) => {
  const problem = folderNameProblem(name)
  if (problem) ctx.addIssue({ code: 'custom', message: `folder name ${problem}` })
})

/** POST /api/workspaces/:wsId/folders, POST /api/user/folders. `parentId` left out or null: at the root. */
export const createFolderBody = z.object({
  name: folderName,
  parentId: objectId.nullish()
})

/** PATCH /api/folders/:folderId: rename and / or move (`parentId` null = to the root). */
export const updateFolderBody = z.object({
  name: folderName.optional(),
  parentId: objectId.nullable().optional()
})

export const folderParams = z.object({ folderId: objectId })

/**
 * GET /api/workspaces/:wsId/documents, GET /api/user/personal-documents.
 * `folder`: `root` (default), `all`, or a folder id. `q` switches to search
 * (ranked, `cursor` is then an offset). `cursor`: from the previous page.
 */
export const docListQuery = z.object({
  folder: z.union([z.literal('root'), z.literal('all'), objectId]).optional().default('root'),
  sort: z.enum(DOC_LIST_SORTS).optional().default('updated'),
  dir: z.enum(['asc', 'desc']).optional(),
  owner: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(200).optional(),
  cursor: z.string().max(600).optional(),
  limit: z.coerce.number().int().min(1).max(DOC_LIST_MAX_LIMIT).optional().default(DOC_LIST_DEFAULT_LIMIT)
})

/** GET /api/search/documents: `scope` `all` (default), `personal` or `ws:<workspaceId>`. */
export const documentSearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  scope: z.union([z.literal('all'), z.literal('personal'), z.string().regex(/^ws:[A-Za-z0-9_-]{1,64}$/)]).optional().default('all'),
  folder: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(SEARCH_MAX_LIMIT).optional().default(20),
  offset: z.coerce.number().int().min(0).max(1000).optional().default(0)
})

/**
 * POST /api/documents/bulk. `move-folder`: `folderId` (null = the root of
 * the documents' own scope); `move-workspace`: `workspaceId` (null = to
 * the caller's personal documents); `delete`. Per-document results.
 */
export const bulkDocumentsBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('move-folder'), docIds: z.array(objectId).min(1).max(BULK_MAX_ITEMS), folderId: objectId.nullable() }),
  z.object({ action: z.literal('move-workspace'), docIds: z.array(objectId).min(1).max(BULK_MAX_ITEMS), workspaceId: objectId.nullable() }),
  z.object({ action: z.literal('delete'), docIds: z.array(objectId).min(1).max(BULK_MAX_ITEMS) })
])

/**
 * POST /api/folders/bulk-move: folders (with their subtrees) and documents
 * of one scope into `targetFolderId` (null = the scope's root). The scope is
 * `workspaceId` (null = the caller's personal documents).
 */
export const bulkMoveBody = z.object({
  workspaceId: objectId.nullable(),
  targetFolderId: objectId.nullable(),
  folderIds: z.array(objectId).max(BULK_MAX_ITEMS).default([]),
  docIds: z.array(objectId).max(BULK_MAX_ITEMS).default([])
}).refine(b => b.folderIds.length + b.docIds.length > 0 && b.folderIds.length + b.docIds.length <= BULK_MAX_ITEMS, { message: 'nothing to move' })

/** PATCH /api/docs/:docId/folder: file one document (null = the root of its scope). */
export const moveDocFolderBody = z.object({ folderId: objectId.nullable() })

/** PUT /api/docs/:docId/title: rename, also in open editors. */
export const renameDocBody = z.object({ title: z.string().trim().min(1).max(DOC_TITLE_MAX_LENGTH) })
