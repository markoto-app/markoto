import { and, asc, eq, sql } from 'drizzle-orm'
import { documents, workspaceTemplates } from '../db/schema'
import { useDatabase } from '../db/client'
import { DuplicateError } from './errors'
import type { DocAccess, WorkspaceAccess } from './proofs'

// Workspace templates: a live link to one of the workspace's
// documents. New documents made from it copy that document's CURRENT text
// and design (server/utils/brandKit/templates.ts).

export interface WorkspaceTemplateRow {
  id: string
  workspaceId: string
  docId: string
  name: string
  description: string
  /** The source document's current title (live). */
  docTitle: string
  createdAt: Date
}

const columns = {
  id: workspaceTemplates.id,
  workspaceId: workspaceTemplates.workspaceId,
  docId: workspaceTemplates.docId,
  name: workspaceTemplates.name,
  description: workspaceTemplates.description,
  docTitle: documents.title,
  createdAt: workspaceTemplates.createdAt
}

export async function listWorkspaceTemplates(ws: WorkspaceAccess<'member'>): Promise<WorkspaceTemplateRow[]> {
  const workspaceId = ws.workspaceId
  // Only templates whose document is still in this workspace (a move
  // deletes the link too, this is the belt to that braces).
  return useDatabase().select(columns).from(workspaceTemplates)
    .innerJoin(documents, and(eq(documents.docId, workspaceTemplates.docId), eq(documents.workspaceId, workspaceTemplates.workspaceId)))
    .where(eq(workspaceTemplates.workspaceId, workspaceId))
    .orderBy(asc(workspaceTemplates.name))
}

/** One template, only if it belongs to `workspaceId` (tuple key) and its document is still there. */
export async function getWorkspaceTemplate(ws: WorkspaceAccess<'member'>, id: string): Promise<WorkspaceTemplateRow | null> {
  const workspaceId = ws.workspaceId
  return (await useDatabase().select(columns).from(workspaceTemplates)
    .innerJoin(documents, and(eq(documents.docId, workspaceTemplates.docId), eq(documents.workspaceId, workspaceTemplates.workspaceId)))
    .where(and(eq(workspaceTemplates.workspaceId, workspaceId), eq(workspaceTemplates.id, id)))
    .limit(1))[0] ?? null
}

export async function countWorkspaceTemplates(ws: WorkspaceAccess<'member'>): Promise<number> {
  const workspaceId = ws.workspaceId
  const r = await useDatabase().select({ n: sql<number>`count(*)::int` }).from(workspaceTemplates)
    .where(eq(workspaceTemplates.workspaceId, workspaceId))
  return Number(r[0]?.n ?? 0)
}

/** `doc` must be a document of the workspace (`proveWorkspaceDoc`); both ids come from the proofs. */
export async function insertWorkspaceTemplate(ws: WorkspaceAccess<'admin'>, doc: DocAccess<'view'>, row: { id: string, name: string, description: string, createdBy: number }): Promise<void> {
  try {
    await useDatabase().insert(workspaceTemplates).values({ ...row, workspaceId: ws.workspaceId, docId: doc.docId })
  } catch (e) {
    if ((e as { code?: string })?.code === '23505' || (e as { cause?: { code?: string } })?.cause?.code === '23505') {
      throw new DuplicateError('A template for this document')
    }
    throw e
  }
}

export async function updateWorkspaceTemplate(ws: WorkspaceAccess<'admin'>, id: string, patch: { name?: string, description?: string }): Promise<boolean> {
  const workspaceId = ws.workspaceId
  const rows = await useDatabase().update(workspaceTemplates).set(patch)
    .where(and(eq(workspaceTemplates.workspaceId, workspaceId), eq(workspaceTemplates.id, id)))
    .returning({ id: workspaceTemplates.id })
  return rows.length > 0
}

export async function deleteWorkspaceTemplate(ws: WorkspaceAccess<'admin'>, id: string): Promise<{ docId: string } | null> {
  const workspaceId = ws.workspaceId
  const rows = await useDatabase().delete(workspaceTemplates)
    .where(and(eq(workspaceTemplates.workspaceId, workspaceId), eq(workspaceTemplates.id, id)))
    .returning({ docId: workspaceTemplates.docId })
  return rows[0] ?? null
}

/** The document left the workspace: its template links there go. */
export async function deleteTemplatesForDoc(doc: DocAccess<'manage'>): Promise<number> {
  const docId = doc.docId
  return (await useDatabase().delete(workspaceTemplates).where(eq(workspaceTemplates.docId, docId)).returning({ id: workspaceTemplates.id })).length
}
