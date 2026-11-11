import { and, asc, eq, sql } from 'drizzle-orm'
import { documents, workspaceTemplates } from '../db/schema'
import { useDatabase } from '../utils/platform/database'
import { DuplicateError } from './errors'

// Workspace templates (WP10c): a live link to one of the workspace's
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

export async function listWorkspaceTemplates(workspaceId: string): Promise<WorkspaceTemplateRow[]> {
  // Only templates whose document is still in this workspace (a move
  // deletes the link too — this is the belt to that braces).
  return useDatabase().select(columns).from(workspaceTemplates)
    .innerJoin(documents, and(eq(documents.docId, workspaceTemplates.docId), eq(documents.workspaceId, workspaceTemplates.workspaceId)))
    .where(eq(workspaceTemplates.workspaceId, workspaceId))
    .orderBy(asc(workspaceTemplates.name))
}

/** One template, only if it belongs to `workspaceId` (tuple key) and its document is still there. */
export async function getWorkspaceTemplate(workspaceId: string, id: string): Promise<WorkspaceTemplateRow | null> {
  return (await useDatabase().select(columns).from(workspaceTemplates)
    .innerJoin(documents, and(eq(documents.docId, workspaceTemplates.docId), eq(documents.workspaceId, workspaceTemplates.workspaceId)))
    .where(and(eq(workspaceTemplates.workspaceId, workspaceId), eq(workspaceTemplates.id, id)))
    .limit(1))[0] ?? null
}

export async function countWorkspaceTemplates(workspaceId: string): Promise<number> {
  const r = await useDatabase().select({ n: sql<number>`count(*)::int` }).from(workspaceTemplates)
    .where(eq(workspaceTemplates.workspaceId, workspaceId))
  return Number(r[0]?.n ?? 0)
}

export async function insertWorkspaceTemplate(row: { id: string, workspaceId: string, docId: string, name: string, description: string, createdBy: number }): Promise<void> {
  try {
    await useDatabase().insert(workspaceTemplates).values(row)
  } catch (e) {
    if ((e as { code?: string })?.code === '23505' || (e as { cause?: { code?: string } })?.cause?.code === '23505') {
      throw new DuplicateError('A template for this document')
    }
    throw e
  }
}

export async function updateWorkspaceTemplate(workspaceId: string, id: string, patch: { name?: string, description?: string }): Promise<boolean> {
  const rows = await useDatabase().update(workspaceTemplates).set(patch)
    .where(and(eq(workspaceTemplates.workspaceId, workspaceId), eq(workspaceTemplates.id, id)))
    .returning({ id: workspaceTemplates.id })
  return rows.length > 0
}

export async function deleteWorkspaceTemplate(workspaceId: string, id: string): Promise<{ docId: string } | null> {
  const rows = await useDatabase().delete(workspaceTemplates)
    .where(and(eq(workspaceTemplates.workspaceId, workspaceId), eq(workspaceTemplates.id, id)))
    .returning({ docId: workspaceTemplates.docId })
  return rows[0] ?? null
}

/** The document left the workspace: its template links there go. */
export async function deleteTemplatesForDoc(docId: string): Promise<number> {
  return (await useDatabase().delete(workspaceTemplates).where(eq(workspaceTemplates.docId, docId)).returning({ id: workspaceTemplates.id })).length
}
