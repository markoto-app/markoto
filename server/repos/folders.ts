import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import { documents, folders } from '../db/schema'
import { useDatabase, executor, asTxHandle, type TxHandle } from '../db/client'
import { ConflictError, DuplicateError, NotFoundError } from './errors'
import { proofUserId, type DocAccess, type UserScope, type WorkspaceAccess } from './proofs'
import { FOLDER_MAX_DEPTH } from '~~/shared/config/imports'

// Folders of one scope: a workspace (the proof is a `WorkspaceAccess`) or one
// user's personal documents (the proof is the user's `UserScope`). Every
// query is constrained to the proof's scope, so a folder id from another
// workspace or another user is "not found". Folders carry no permissions:
// reading needs any role in the workspace, changing needs editor (the
// policy picks the level), the owner for personal folders.

/** Who a folder belongs to: a workspace proof, or the user whose personal folders these are. */
export type FolderScope = WorkspaceAccess<'member'> | UserScope
export type FolderWriteScope = WorkspaceAccess<'editor'> | UserScope

export interface FolderRow {
  folderId: string
  parentId: string | null
  name: string
  position: string
  createdAt: Date
  updatedAt: Date
  /** Documents filed directly in this folder (not in subfolders). */
  docCount: number
}

interface ScopeIds { workspaceId: string | null, ownerId: number | null }

function scopeIds(scope: FolderScope): ScopeIds {
  if ('workspaceId' in scope) return { workspaceId: scope.workspaceId, ownerId: null }
  return { workspaceId: null, ownerId: scope.userId }
}

/** The folders of the scope (SQL condition on `folders`). */
function folderScopeSql(scope: FolderScope): SQL {
  const ids = scopeIds(scope)
  return ids.workspaceId !== null
    ? sql`${folders.workspaceId} = ${ids.workspaceId}`
    : sql`${folders.ownerId} = ${ids.ownerId} AND ${folders.workspaceId} IS NULL`
}

/** The documents of the scope (SQL condition on `documents`). */
export function docScopeSql(scope: FolderScope): SQL {
  const ids = scopeIds(scope)
  return ids.workspaceId !== null
    ? sql`${documents.workspaceId} = ${ids.workspaceId}`
    : sql`${documents.ownerId} = ${ids.ownerId} AND ${documents.workspaceId} IS NULL`
}

/** Advisory lock key of the scope's folder tree: serialises moves so two of them can't form a cycle. */
function treeLockKey(scope: FolderScope): string {
  const ids = scopeIds(scope)
  return ids.workspaceId !== null ? `folders:ws:${ids.workspaceId}` : `folders:user:${ids.ownerId}`
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string, cause?: { code?: string } } | null
  return err?.code === '23505' || err?.cause?.code === '23505'
}

/** Every folder of the scope, flat, with the number of documents filed directly in each. */
export async function listFolders(scope: FolderScope): Promise<FolderRow[]> {
  const rows = await useDatabase()
    .select({
      folderId: folders.folderId,
      parentId: folders.parentId,
      name: folders.name,
      position: folders.position,
      createdAt: folders.createdAt,
      updatedAt: folders.updatedAt,
      // Qualified by hand: Drizzle drops table names in a one-table select,
      // which would compare the subquery's column with itself.
      docCount: sql<number>`(SELECT count(*)::int FROM documents d WHERE d.folder_id = "folders"."folder_id")`
    })
    .from(folders)
    .where(folderScopeSql(scope))
    .orderBy(sql`lower(${folders.name})`, folders.folderId)
  return rows.map(r => ({ ...r, docCount: Number(r.docCount) }))
}

/** One folder of the scope, or null (also for a folder of another scope). */
export async function getFolder(scope: FolderScope, folderId: string, tx?: TxHandle): Promise<Omit<FolderRow, 'docCount'> | null> {
  return (await executor(tx)
    .select({
      folderId: folders.folderId,
      parentId: folders.parentId,
      name: folders.name,
      position: folders.position,
      createdAt: folders.createdAt,
      updatedAt: folders.updatedAt
    })
    .from(folders)
    .where(and(eq(folders.folderId, folderId), folderScopeSql(scope)))
    .limit(1))[0] ?? null
}

/**
 * The folder and its ancestors, root first. Empty when the folder is not in
 * the scope. Bounded by the depth limit (a corrupt cycle can't loop).
 */
export async function folderPath(scope: FolderScope, folderId: string, tx?: TxHandle): Promise<Array<{ folderId: string, name: string, parentId: string | null }>> {
  const ids = scopeIds(scope)
  const result = await executor(tx).execute<{ folder_id: string, name: string, parent_id: string | null, depth: number }>(sql`
    WITH RECURSIVE up AS (
      SELECT folder_id, name, parent_id, 0 AS depth FROM folders
      WHERE folder_id = ${folderId}
        AND (workspace_id IS NOT DISTINCT FROM ${ids.workspaceId}::text) AND (owner_id IS NOT DISTINCT FROM ${ids.ownerId}::int)
      UNION ALL
      SELECT f.folder_id, f.name, f.parent_id, up.depth + 1 FROM folders f
      JOIN up ON f.folder_id = up.parent_id
      WHERE up.depth < ${FOLDER_MAX_DEPTH + 2}
        AND (f.workspace_id IS NOT DISTINCT FROM ${ids.workspaceId}::text) AND (f.owner_id IS NOT DISTINCT FROM ${ids.ownerId}::int)
    )
    SELECT folder_id, name, parent_id, depth FROM up ORDER BY depth DESC
  `)
  return result.rows.map(r => ({ folderId: r.folder_id, name: r.name, parentId: r.parent_id }))
}

/** Ids of the folder and every folder below it (the folder first). Empty when not in the scope. */
export async function folderSubtreeIds(scope: FolderScope, folderId: string, tx?: TxHandle): Promise<string[]> {
  const ids = scopeIds(scope)
  const result = await executor(tx).execute<{ folder_id: string }>(sql`
    WITH RECURSIVE down AS (
      SELECT folder_id, 0 AS depth FROM folders
      WHERE folder_id = ${folderId}
        AND (workspace_id IS NOT DISTINCT FROM ${ids.workspaceId}::text) AND (owner_id IS NOT DISTINCT FROM ${ids.ownerId}::int)
      UNION ALL
      SELECT f.folder_id, down.depth + 1 FROM folders f JOIN down ON f.parent_id = down.folder_id
      WHERE down.depth < ${FOLDER_MAX_DEPTH + 2}
    )
    SELECT folder_id FROM down ORDER BY depth
  `)
  return result.rows.map(r => r.folder_id)
}

/** Levels below the folder (0 = no subfolders). */
async function subtreeHeight(scope: FolderScope, folderId: string, tx?: TxHandle): Promise<number> {
  const ids = scopeIds(scope)
  const result = await executor(tx).execute<{ h: number | null }>(sql`
    WITH RECURSIVE down AS (
      SELECT folder_id, 0 AS depth FROM folders
      WHERE folder_id = ${folderId}
        AND (workspace_id IS NOT DISTINCT FROM ${ids.workspaceId}::text) AND (owner_id IS NOT DISTINCT FROM ${ids.ownerId}::int)
      UNION ALL
      SELECT f.folder_id, down.depth + 1 FROM folders f JOIN down ON f.parent_id = down.folder_id
      WHERE down.depth < ${FOLDER_MAX_DEPTH + 2}
    )
    SELECT max(depth)::int AS h FROM down
  `)
  return Number(result.rows[0]?.h ?? 0)
}

/**
 * Create a folder. `parentId` null = at the scope's root. Throws
 * `NotFoundError` for a parent outside the scope, `ConflictError` when the
 * new folder would be deeper than the limit, `DuplicateError` when a sibling
 * already has the name (case-insensitive).
 */
export async function createFolder(scope: FolderWriteScope, input: { folderId: string, name: string, parentId: string | null }, tx?: TxHandle): Promise<Omit<FolderRow, 'docCount'>> {
  const ids = scopeIds(scope)
  const run = async (t: TxHandle | undefined): Promise<Omit<FolderRow, 'docCount'>> => {
    if (input.parentId !== null) {
      const path = await folderPath(scope, input.parentId, t)
      if (path.length === 0) throw new NotFoundError('Folder')
      if (path.length >= FOLDER_MAX_DEPTH) throw new ConflictError('folder-too-deep')
    }
    try {
      const row = (await executor(t).insert(folders).values({
        folderId: input.folderId,
        workspaceId: ids.workspaceId,
        ownerId: ids.ownerId,
        parentId: input.parentId,
        name: input.name,
        createdBy: proofUserId(scope)
      }).returning())[0]
      if (!row) throw new Error('createFolder: insert returned nothing')
      return { folderId: row.folderId, parentId: row.parentId, name: row.name, position: row.position, createdAt: row.createdAt, updatedAt: row.updatedAt }
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateError('Folder')
      throw e
    }
  }
  return run(tx)
}

/**
 * The child of `parentId` named `name` (case-insensitive), created if
 * missing. Used by imports to mirror an uploaded folder structure; a
 * concurrent creation of the same name is absorbed.
 */
export async function ensureChildFolder(scope: FolderWriteScope, parentId: string | null, name: string, newFolderId: () => string): Promise<string> {
  const find = async () => (await useDatabase()
    .select({ folderId: folders.folderId })
    .from(folders)
    .where(and(
      folderScopeSql(scope),
      parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId),
      sql`lower(${folders.name}) = lower(${name})`
    ))
    .limit(1))[0]?.folderId
  const existing = await find()
  if (existing) return existing
  try {
    const created = await createFolder(scope, { folderId: newFolderId(), name, parentId })
    return created.folderId
  } catch (e) {
    if (e instanceof DuplicateError) {
      const again = await find()
      if (again) return again
    }
    throw e
  }
}

/** Rename a folder of the scope. Throws `NotFoundError` / `DuplicateError`. Returns the old name. */
export async function renameFolder(scope: FolderWriteScope, folderId: string, name: string): Promise<{ before: string }> {
  const before = await getFolder(scope, folderId)
  if (!before) throw new NotFoundError('Folder')
  try {
    await useDatabase().update(folders)
      .set({ name, updatedAt: new Date() })
      .where(and(eq(folders.folderId, folderId), folderScopeSql(scope)))
  } catch (e) {
    if (isUniqueViolation(e)) throw new DuplicateError('Folder')
    throw e
  }
  return { before: before.name }
}

/**
 * Move a folder (with everything below it) under `parentId` (null = root),
 * within the scope. Refuses a move into itself or its own subtree
 * (`ConflictError('folder-cycle')`) and one that would exceed the depth
 * limit (`ConflictError('folder-too-deep')`). Serialised per scope so two
 * concurrent moves can't build a cycle together. With `name`, renames in
 * the same statement, so a refused move never leaves a half-applied rename.
 * Returns the old parent.
 */
export async function moveFolder(scope: FolderWriteScope, folderId: string, parentId: string | null, name?: string): Promise<{ before: string | null }> {
  return useDatabase().transaction(async (dtx) => {
    const tx = asTxHandle(dtx)
    await dtx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${treeLockKey(scope)}))`)
    const folder = await getFolder(scope, folderId, tx)
    if (!folder) throw new NotFoundError('Folder')
    if (folder.parentId === parentId && (name === undefined || name === folder.name)) return { before: folder.parentId }
    let targetDepth = 0
    if (parentId !== null) {
      const path = await folderPath(scope, parentId, tx)
      if (path.length === 0) throw new NotFoundError('Folder')
      if (path.some(p => p.folderId === folderId)) throw new ConflictError('folder-cycle')
      targetDepth = path.length
    }
    const height = await subtreeHeight(scope, folderId, tx)
    if (targetDepth + 1 + height > FOLDER_MAX_DEPTH) throw new ConflictError('folder-too-deep')
    try {
      await dtx.update(folders)
        .set({ parentId, ...(name === undefined ? {} : { name }), updatedAt: new Date() })
        .where(and(eq(folders.folderId, folderId), folderScopeSql(scope)))
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateError('Folder')
      throw e
    }
    return { before: folder.parentId }
  })
}

/**
 * What deleting a folder removes: its subfolders and the documents filed
 * anywhere below it, and how many of those documents the actor may NOT
 * delete (`canDeleteAll` needs the workspace admin role, or ownership of
 * each document: the same rule as deleting one document).
 */
export async function folderDeletePlan(scope: FolderScope, folderId: string): Promise<{ folderIds: string[], docIds: string[], blockedDocs: number } | null> {
  const folderIds = await folderSubtreeIds(scope, folderId)
  if (folderIds.length === 0) return null
  const actorId = proofUserId(scope) ?? -1
  const isAdmin = 'workspaceId' in scope && scope.allows('admin')
  const rows = await useDatabase()
    .select({ docId: documents.docId, ownerId: documents.ownerId })
    .from(documents)
    .where(and(docScopeSql(scope), inArray(documents.folderId, folderIds)))
  const blockedDocs = isAdmin ? 0 : rows.filter(r => r.ownerId !== actorId).length
  return { folderIds, docIds: rows.map(r => r.docId), blockedDocs }
}

/** Delete a folder row of the scope; its subfolders go with it (FK cascade). Documents must be gone first. */
export async function deleteFolderRow(scope: FolderWriteScope, folderId: string): Promise<boolean> {
  const result = await useDatabase().delete(folders)
    .where(and(eq(folders.folderId, folderId), folderScopeSql(scope)))
    .returning({ folderId: folders.folderId })
  return result.length > 0
}

/**
 * File a document into `folderId` (null = the scope's root). The folder must
 * belong to the document's own scope: its workspace, or its owner's personal
 * folders when it has no workspace; else `NotFoundError('Folder')`. Moving
 * between folders is organisation, so an edit proof is enough. Returns the
 * previous folder id.
 */
export async function moveDocToFolder(doc: DocAccess<'edit'>, folderId: string | null): Promise<{ before: string | null }> {
  return useDatabase().transaction(async (tx) => {
    const current = (await tx.select({ folderId: documents.folderId })
      .from(documents).where(eq(documents.docId, doc.docId)).limit(1).for('update'))[0]
    if (!current) throw new NotFoundError('Document')
    if (current.folderId === folderId) return { before: current.folderId }
    const result = await tx.execute<{ doc_id: string }>(sql`
      UPDATE documents d SET folder_id = ${folderId}
      WHERE d.doc_id = ${doc.docId}
        AND (${folderId}::text IS NULL OR EXISTS (
          SELECT 1 FROM folders f WHERE f.folder_id = ${folderId}
            AND ((d.workspace_id IS NOT NULL AND f.workspace_id = d.workspace_id)
              OR (d.workspace_id IS NULL AND f.workspace_id IS NULL AND f.owner_id = d.owner_id))))
      RETURNING d.doc_id
    `)
    if (result.rows.length === 0) throw new NotFoundError('Folder')
    return { before: current.folderId }
  })
}
