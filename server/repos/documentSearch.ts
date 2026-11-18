import { sql, type SQL } from 'drizzle-orm'
import { useDatabase } from '../db/client'
import { proofUserId, type DocAccess, type SystemActor, type UserScope, type WorkspaceAccess } from './proofs'
import { SNIPPET_START, SNIPPET_STOP } from '~~/shared/utils/documents/searchQuery'

// The `document_search` table: one plain-text copy per document (title +
// Markdown body) and the queries over it. Written by the sync server on every
// store (`sync-server/src/search-index.ts`, same upsert) and by the app's own
// content writers through `upsertDocumentSearch`.

/** Longest body kept in the index (characters). Postgres refuses a tsvector over 1 MB. */
export const SEARCH_BODY_MAX_CHARS = 400_000

/**
 * Write a document's indexed text. Only replaces a row that reflects an
 * older (or unknown) Y.js state, so a writer that read the log before
 * another one stored can't put older text back. Anonymous documents (no
 * owner, no workspace) are never indexed. Also sets the document's word
 * count, size and (when the text or title changed) "last edited".
 */
export async function upsertDocumentSearch(
  doc: DocAccess<'write'>,
  input: { title: string, body: string, yjsId: number | null, wordCount: number, sizeBytes: number }
): Promise<void> {
  const body = input.body.slice(0, SEARCH_BODY_MAX_CHARS)
  const title = input.title.trim().slice(0, 255)
  await useDatabase().execute(sql`
    WITH prev AS (SELECT title, body FROM document_search WHERE doc_id = ${doc.docId}),
    up AS (
      INSERT INTO document_search (doc_id, title, body, yjs_id, updated_at)
      SELECT d.doc_id, COALESCE(NULLIF(${title}, ''), d.title), ${body}, ${input.yjsId}::bigint, now()
      FROM documents d
      WHERE d.doc_id = ${doc.docId} AND (d.owner_id IS NOT NULL OR d.workspace_id IS NOT NULL)
      ON CONFLICT (doc_id) DO UPDATE
        SET title = excluded.title, body = excluded.body, yjs_id = excluded.yjs_id, updated_at = now()
        WHERE document_search.yjs_id IS NULL OR excluded.yjs_id IS NULL OR document_search.yjs_id <= excluded.yjs_id
      RETURNING doc_id, title, body
    )
    UPDATE documents d SET
      word_count = ${input.wordCount},
      size_bytes = ${input.sizeBytes},
      title = CASE WHEN ${title} <> '' THEN ${title} ELSE d.title END,
      updated_at = CASE
        WHEN (SELECT body FROM prev) IS DISTINCT FROM (SELECT body FROM up)
          OR (SELECT title FROM prev) IS DISTINCT FROM (SELECT title FROM up) THEN now()
        ELSE d.updated_at END
    WHERE d.doc_id = ${doc.docId} AND EXISTS (SELECT 1 FROM up)
  `)
}

/**
 * Documents with an owner or a workspace but no index row yet (created
 * before the index existed, or whose store happened while it was missing).
 * The backfill indexes them in batches.
 */
export async function listUnindexedDocIds(_by: SystemActor, limit: number): Promise<string[]> {
  const result = await useDatabase().execute<{ doc_id: string }>(sql`
    SELECT d.doc_id FROM documents d
    WHERE (d.owner_id IS NOT NULL OR d.workspace_id IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM document_search s WHERE s.doc_id = d.doc_id)
    ORDER BY d.id
    LIMIT ${limit}
  `)
  return result.rows.map(r => r.doc_id)
}

export interface SearchHit {
  docId: string
  title: string
  workspaceId: string | null
  folderId: string | null
  ownerId: number | null
  updatedAt: Date
  /** Body excerpt around the matches; matched words between `SNIPPET_START` / `SNIPPET_STOP`. Empty for a title-only hit. */
  snippet: string
  rank: number
}

export interface SearchScopes {
  /** Workspaces the caller is a member of (SSO-checked proofs). */
  workspaces: ReadonlyArray<WorkspaceAccess<'member'>>
  /** The caller's personal documents (no workspace). */
  personal: boolean
  /** Documents shared with the caller as a workspace guest. */
  shared: boolean
  /** Only documents in these folders (a folder and its subfolders), of the single workspace / personal scope given. */
  folderIds?: readonly string[]
}

/**
 * Search the documents the caller can reach: their personal documents,
 * every workspace they hold a proof for, and documents shared with them as a
 * guest. `tsQuery` is a prefix query from `prefixTsQuery` (letters and digits
 * only); `raw` is the typed text for the title similarity. Documents not yet
 * indexed match by title only. Ranked: title matches first, then text.
 */
export async function searchDocuments(
  self: UserScope,
  scopes: SearchScopes,
  q: { tsQuery: string | null, raw: string, limit: number, offset: number }
): Promise<SearchHit[]> {
  const userId = self.userId
  const wsIds = scopes.workspaces.filter(w => proofUserId(w) === userId).map(w => w.workspaceId)
  const reach: SQL[] = []
  if (scopes.personal) reach.push(sql`(d.owner_id = ${userId} AND d.workspace_id IS NULL)`)
  if (wsIds.length > 0) reach.push(sql`d.workspace_id IN (${sql.join(wsIds.map(id => sql`${id}`), sql`, `)})`)
  if (scopes.shared) reach.push(sql`EXISTS (SELECT 1 FROM document_shares ds WHERE ds.doc_id = d.doc_id AND ds.user_id = ${userId})`)
  if (reach.length === 0) return []
  const reachSql = sql.join(reach, sql` OR `)
  const folderSql = scopes.folderIds && scopes.folderIds.length > 0
    ? sql` AND d.folder_id IN (${sql.join(scopes.folderIds.map(id => sql`${id}`), sql`, `)})`
    : sql``
  const like = `%${q.raw.replace(/[\\%_]/g, c => `\\${c}`)}%`
  const tsq = q.tsQuery === null ? sql`NULL::tsquery` : sql`to_tsquery('simple', ${q.tsQuery})`
  const headlineOptions = `StartSel="${SNIPPET_START}", StopSel="${SNIPPET_STOP}", MaxFragments=2, MinWords=6, MaxWords=18, FragmentDelimiter=" ... "`
  const result = await useDatabase().execute<{
    doc_id: string
    title: string
    workspace_id: string | null
    folder_id: string | null
    owner_id: number | null
    updated_at: string | Date
    snippet: string | null
    rank: number
  }>(sql`
    WITH query AS (SELECT ${tsq} AS tsq),
    hits AS (
      SELECT d.doc_id, d.title, d.workspace_id, d.folder_id, d.owner_id, d.updated_at,
        (CASE WHEN d.title ILIKE ${like} THEN 2 ELSE 0 END)
          + COALESCE(similarity(s.title, ${q.raw}), 0)
          + COALESCE(ts_rank_cd(s.body_tsv, (SELECT tsq FROM query)), 0) AS rank,
        s.body IS NOT NULL AND (SELECT tsq FROM query) IS NOT NULL AND s.body_tsv @@ (SELECT tsq FROM query) AS body_match
      FROM documents d
      LEFT JOIN document_search s ON s.doc_id = d.doc_id
      WHERE (${reachSql})${folderSql}
        AND (
          d.title ILIKE ${like}
          OR (s.doc_id IS NOT NULL AND (SELECT tsq FROM query) IS NOT NULL AND s.body_tsv @@ (SELECT tsq FROM query))
          OR (s.doc_id IS NOT NULL AND s.title % ${q.raw})
        )
      ORDER BY rank DESC, d.updated_at DESC, d.doc_id
      LIMIT ${q.limit} OFFSET ${q.offset}
    )
    SELECT h.doc_id, h.title, h.workspace_id, h.folder_id, h.owner_id, h.updated_at, h.rank,
      CASE WHEN h.body_match THEN ts_headline('simple', s.body, (SELECT tsq FROM query), ${headlineOptions}) ELSE NULL END AS snippet
    FROM hits h LEFT JOIN document_search s ON s.doc_id = h.doc_id
    ORDER BY h.rank DESC, h.updated_at DESC, h.doc_id
  `)
  return result.rows.map(r => ({
    docId: r.doc_id,
    title: r.title,
    workspaceId: r.workspace_id,
    folderId: r.folder_id,
    ownerId: r.owner_id,
    updatedAt: r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at),
    snippet: r.snippet ?? '',
    rank: Number(r.rank)
  }))
}
