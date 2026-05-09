import * as Y from 'yjs'
import { useDatabasePool } from './database'

// Clone Y.js state from one docId to another, rewriting image URLs in
// the process so the target doc's markdown references its own
// `/api/files/{targetDocId}/...` paths instead of the source's.
//
// Why not a raw SQL `INSERT … SELECT` of the yjs_documents rows?
// Because the update blobs reference image URLs by literal string, and
// an unrewritten clone would leave the duplicate pointing at
// `/api/files/{sourceDocId}/…` — the /api/files endpoint gates access
// by the URL's docId, so a workspace member of the duplicate (but not
// the source) would get 403s on every image. Deleting the source would
// also kill the duplicate's images.
//
// Approach:
//   1. Reconstruct the source Y.Doc by applying every stored update
//      (mirrors what y-postgresql does when the sync-server loads).
//   2. Grab ytext as a plain string and replace-all the image URL
//      prefix.
//   3. Build a FRESH Y.Doc, insert the rewritten text + copy ymeta
//      entries except `_deleted` (source might have transient state).
//   4. Encode the fresh doc's full state as a single update and INSERT
//      one row into yjs_documents under the target docname. Hocuspocus
//      loads it verbatim the next time someone opens the duplicate.
//
// The sync-server's y-postgresql will treat our single row as the
// whole history; it merges updates internally as new edits come in,
// so there's no long-term difference vs. a normal-history doc.
//
// Caveat: if the source doc is currently open and actively edited, the
// last few seconds of writes may only live in the sync-server's
// in-memory Y.Doc (Hocuspocus debounces onStoreDocument). Those writes
// won't be reflected in the clone. Acceptable for typical duplicate
// flows — users copy settled templates, not mid-keystroke docs. If we
// need stronger guarantees later, add `/internal/flush-document` on
// the sync-server and call it before this runs.
export async function cloneYjsStateWithUrlRewrite(
  sourceDocId: string,
  targetDocId: string
): Promise<void> {
  const pool = useDatabasePool()

  // Pull every v1 (update) row for the source. Ordered by id so the
  // replay is deterministic. v1_sv (state vector) rows are derived data
  // — y-postgresql will recompute them on the target after first write.
  const res = await pool.query<{ value: Buffer }>(
    `SELECT value FROM yjs_documents WHERE docname = $1 AND version = 'v1' ORDER BY id ASC`,
    [sourceDocId]
  )

  // No rows → source hasn't been opened / persisted yet. Nothing to
  // clone; the duplicate will start empty on first open, which is the
  // correct behavior (the documents row already has title + theme).
  if (res.rowCount === 0) return

  const sourceDoc = new Y.Doc()
  for (const row of res.rows) {
    Y.applyUpdate(sourceDoc, new Uint8Array(row.value.buffer, row.value.byteOffset, row.value.byteLength))
  }

  const sourceText = sourceDoc.getText('content').toJSON()
  const rewritten = sourceText.replaceAll(
    `/api/files/${sourceDocId}/`,
    `/api/files/${targetDocId}/`
  )

  const targetDoc = new Y.Doc()
  if (rewritten.length > 0) {
    targetDoc.getText('content').insert(0, rewritten)
  }

  // Mirror ymeta (title, theme, custom client fields) minus transient
  // control flags. Duplicates should never carry the source's
  // `_deleted` marker or other session-scoped flags.
  const sourceMeta = sourceDoc.getMap('meta')
  const targetMeta = targetDoc.getMap('meta')
  sourceMeta.forEach((value, key) => {
    if (key === '_deleted') return
    targetMeta.set(key, value)
  })

  const update = Buffer.from(Y.encodeStateAsUpdate(targetDoc))
  await pool.query(
    `INSERT INTO yjs_documents (docname, value, version) VALUES ($1, $2, 'v1')`,
    [targetDocId, update]
  )
}
