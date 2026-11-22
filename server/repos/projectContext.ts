import { and, eq, sql } from 'drizzle-orm'
import { documentContextLinks, documents } from '../db/schema'
import { useDatabase } from '../db/client'
import { ConflictError, NotFoundError } from './errors'
import type { DocAccess } from './proofs'
import type { ContextScope } from '~~/shared/config/projectContext'

// Project context ("bible") rows: which documents are marked as standing AI
// context (`documents.context_scope`) and the extra context documents
// attached to one document (`document_context_links`). These functions only
// name candidate documents; whether the caller may read one is decided per
// document by the access layer (server/utils/documents/projectContext.ts).

/** Where a candidate comes from, in prompt order: the whole scope, the folder chain, an attachment. */
export type ContextSource = 'all' | 'folder' | 'link'

export interface ContextCandidate {
  docId: string
  source: ContextSource
  /** Folder chain only: 0 = the scope's root, higher = closer to the document. */
  depth: number
}

/** Mark a document as project context for its folder or its whole scope, or unmark it (null). */
export async function setContextScope(doc: DocAccess<'edit'>, scope: ContextScope | null): Promise<void> {
  const result = await useDatabase().update(documents)
    .set({ contextScope: scope })
    .where(eq(documents.docId, doc.docId))
    .returning({ docId: documents.docId })
  if (result.length === 0) throw new NotFoundError('Document')
}

/** The document's own mark (null = not a context document). */
export async function getContextScope(doc: DocAccess<'view'>): Promise<ContextScope | null> {
  const row = (await useDatabase()
    .select({ contextScope: documents.contextScope })
    .from(documents)
    .where(eq(documents.docId, doc.docId))
    .limit(1))[0]
  return row?.contextScope ?? null
}

/**
 * The context documents that apply to `doc`, before any access check:
 * marked documents of the same scope (its workspace, or its owner's personal
 * documents when it has none) marked `all`, or marked `folder` and filed in
 * the document's folder, one of its ancestors or the root; then the
 * documents attached to it. The document itself is never its own context.
 * Anonymous documents (no scope) only have attachments.
 */
export async function listContextCandidates(doc: DocAccess<'view'>, limit: number): Promise<ContextCandidate[]> {
  const result = await useDatabase().execute<{ doc_id: string, source: ContextSource, depth: number }>(sql`
    WITH RECURSIVE target AS (
      SELECT doc_id, workspace_id, owner_id, folder_id FROM documents WHERE doc_id = ${doc.docId}
    ),
    chain AS (
      SELECT f.folder_id, f.parent_id, 0 AS up
      FROM folders f JOIN target t ON f.folder_id = t.folder_id
      UNION ALL
      SELECT f.folder_id, f.parent_id, c.up + 1
      FROM folders f JOIN chain c ON f.folder_id = c.parent_id
      WHERE c.up < 64
    ),
    levels AS (
      SELECT folder_id, (SELECT max(up) FROM chain) - up + 1 AS depth FROM chain
    ),
    marked AS (
      SELECT d.doc_id,
        CASE WHEN d.context_scope = 'all' THEN 'all' ELSE 'folder' END AS source,
        CASE WHEN d.context_scope = 'all' THEN 0 ELSE coalesce(l.depth, 0) END AS depth
      FROM documents d
      JOIN target t ON (
        (t.workspace_id IS NOT NULL AND d.workspace_id = t.workspace_id)
        OR (t.workspace_id IS NULL AND t.owner_id IS NOT NULL AND d.workspace_id IS NULL AND d.owner_id = t.owner_id)
      )
      LEFT JOIN levels l ON l.folder_id = d.folder_id
      WHERE d.context_scope IS NOT NULL
        AND d.doc_id <> t.doc_id
        AND (d.context_scope = 'all' OR d.folder_id IS NULL OR l.folder_id IS NOT NULL)
    ),
    linked AS (
      SELECT k.context_doc_id AS doc_id, 'link' AS source, 0 AS depth, k.created_at
      FROM document_context_links k
      WHERE k.doc_id = ${doc.docId} AND k.context_doc_id <> ${doc.docId}
    )
    SELECT doc_id, source, depth FROM (
      SELECT doc_id, source, depth, 0 AS grp, NULL::timestamptz AS created_at FROM marked
      UNION ALL
      SELECT doc_id, source, depth, 1 AS grp, created_at FROM linked
    ) u
    ORDER BY grp, CASE source WHEN 'all' THEN 0 ELSE 1 END, depth, created_at NULLS FIRST, doc_id
    LIMIT ${limit}
  `)
  const seen = new Set<string>()
  const out: ContextCandidate[] = []
  for (const r of result.rows) {
    if (seen.has(r.doc_id)) continue
    seen.add(r.doc_id)
    out.push({ docId: r.doc_id, source: r.source, depth: Number(r.depth) })
  }
  return out
}

/** Documents attached to `doc` as extra context, oldest first. */
export async function listContextLinks(doc: DocAccess<'view'>): Promise<string[]> {
  const rows = await useDatabase()
    .select({ contextDocId: documentContextLinks.contextDocId })
    .from(documentContextLinks)
    .where(eq(documentContextLinks.docId, doc.docId))
    .orderBy(documentContextLinks.createdAt, documentContextLinks.contextDocId)
  return rows.map(r => r.contextDocId)
}

/**
 * Attach `target` to `doc` as extra context. Idempotent; refuses a
 * document as its own context and more than `max` attachments
 * (`ConflictError`). The count and the insert run under one lock per
 * document so two concurrent attaches cannot pass the cap together.
 */
export async function addContextLink(doc: DocAccess<'edit'>, target: DocAccess<'view'>, addedBy: number, max: number): Promise<void> {
  if (doc.docId === target.docId) throw new ConflictError('A document cannot be its own context')
  await useDatabase().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`context-links:${doc.docId}`}))`)
    const existing = await tx.select({ contextDocId: documentContextLinks.contextDocId })
      .from(documentContextLinks)
      .where(eq(documentContextLinks.docId, doc.docId))
    if (existing.some(r => r.contextDocId === target.docId)) return
    if (existing.length >= max) throw new ConflictError('Too many context documents')
    await tx.insert(documentContextLinks)
      .values({ docId: doc.docId, contextDocId: target.docId, addedBy })
      .onConflictDoNothing()
  })
}

/** Detach a context document from `doc`. Resolves false when it was not attached. */
export async function removeContextLink(doc: DocAccess<'edit'>, contextDocId: string): Promise<boolean> {
  const result = await useDatabase().delete(documentContextLinks)
    .where(and(eq(documentContextLinks.docId, doc.docId), eq(documentContextLinks.contextDocId, contextDocId)))
    .returning({ docId: documentContextLinks.docId })
  return result.length > 0
}

/** The live title of a context document (lists in the document panel). */
export async function getContextDocTitle(doc: DocAccess<'view'>): Promise<string | null> {
  const row = (await useDatabase()
    .select({ title: documents.title })
    .from(documents)
    .where(eq(documents.docId, doc.docId))
    .limit(1))[0]
  return row?.title ?? null
}
