import type { Queryable } from './yjs-store'

// The document's search index row (`document_search`, schema in
// server/db/schema/documents.ts) and its list fields, written after every
// store: the plain text and title the sync server has in hand anyway. Same
// statement as the app's `upsertDocumentSearch` (server/repos/documentSearch.ts):
// keep the two in step.
//
//   - a row is only replaced by text of a newer (or equal) `yjs_updates` id,
//     so two sync instances storing out of order can't put older text back;
//   - anonymous documents (no owner, no workspace) are never indexed;
//   - `documents.word_count` / `size_bytes` follow the text, and
//     `updated_at` moves when the text or title changed;
//   - `documents.title` follows the live title (`ymeta.title`) when one is
//     set, so a rename by any editor reaches the lists.
//
// Best effort: a failure is logged by the caller and never fails the store.

/** Longest body kept in the index (characters). Postgres refuses a tsvector over 1 MB. */
const SEARCH_BODY_MAX_CHARS = 400_000
const TITLE_MAX_CHARS = 255

export interface IndexInput {
  docId: string
  /** `ymeta.title`; '' when the document has none (the row's title is kept). */
  title: string
  body: string
  yjsId: number
  wordCount: number
}

const UPSERT_SQL = `
  WITH prev AS (SELECT title, body FROM document_search WHERE doc_id = $1),
  up AS (
    INSERT INTO document_search (doc_id, title, body, yjs_id, updated_at)
    SELECT d.doc_id, COALESCE(NULLIF($2, ''), d.title), $3, $4::bigint, now()
    FROM documents d
    WHERE d.doc_id = $1 AND (d.owner_id IS NOT NULL OR d.workspace_id IS NOT NULL)
    ON CONFLICT (doc_id) DO UPDATE
      SET title = excluded.title, body = excluded.body, yjs_id = excluded.yjs_id, updated_at = now()
      WHERE document_search.yjs_id IS NULL OR document_search.yjs_id <= excluded.yjs_id
    RETURNING doc_id, title, body
  )
  UPDATE documents d SET
    word_count = $5,
    size_bytes = $6,
    title = CASE WHEN $2 <> '' THEN $2 ELSE d.title END,
    updated_at = CASE
      WHEN (SELECT body FROM prev) IS DISTINCT FROM (SELECT body FROM up)
        OR (SELECT title FROM prev) IS DISTINCT FROM (SELECT title FROM up) THEN now()
      ELSE d.updated_at END
  WHERE d.doc_id = $1 AND EXISTS (SELECT 1 FROM up)`

/** Write the index row and list fields of one stored document. Resolves true when a row was written. */
export async function indexStoredDocument(db: Queryable, input: IndexInput): Promise<boolean> {
  const title = input.title.trim().slice(0, TITLE_MAX_CHARS)
  const body = input.body.slice(0, SEARCH_BODY_MAX_CHARS)
  const sizeBytes = Buffer.byteLength(input.body, 'utf8')
  const result = await db.query(UPSERT_SQL, [input.docId, title, body, input.yjsId, input.wordCount, sizeBytes])
  return (result.rowCount ?? 0) > 0
}

/** The table is missing (the app's migration has not run yet during a deploy): not worth an alert. */
export function isMissingTable(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '42P01'
}
