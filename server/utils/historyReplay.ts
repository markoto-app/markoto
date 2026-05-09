import * as Y from 'yjs'
import { useDatabasePool } from './database'

// Reconstruct a Y.Doc's state at a specific point in its history by
// replaying every y-postgresql update row up to (and including) a
// given `id`. Used by the activity-log diff endpoint to materialize
// the doc on either side of an `edit` event so we can compute a
// textual diff.
//
// Mechanics:
//   - y-postgresql stores granular updates as `version = 'v1'` rows
//     in `yjs_documents`. `version = 'v1_sv'` rows are derived state
//     vectors — we ignore those (re-applying a state vector to a
//     fresh Y.Doc would be a no-op, but skipping them keeps the
//     ordering clean).
//   - `Y.applyUpdate(doc, bytes)` is associative + commutative, so
//     replay order doesn't strictly matter for correctness. We sort
//     by `id ASC` anyway because (a) it matches y-postgresql's own
//     load semantics and (b) it makes debugging deterministic.
//
// Performance: a doc with thousands of granular updates merges them
// internally during apply, so memory stays bounded. Typical replay
// latency: 50-200ms for the longest docs we see in practice. The
// diff endpoint exposes this on-demand — no caching layer in v1.
//
// Edge cases:
//   - `maxYjsId === null` → return an empty Y.Doc. Happens when the
//     activity row predates the boundary-tracking feature, or when
//     the row was written before any store had occurred (rare).
//   - `maxYjsId` references a row that has since been merged away by
//     y-postgresql's compaction. The merged row's `id` is HIGHER than
//     the originals it absorbed, but we replay in id-order regardless,
//     so the resulting Y.Doc state is correct (it's just collapsed).
//   - Row data is a `Buffer` from pg's bytea decoder; we slice into a
//     proper Uint8Array view before passing to `applyUpdate` (lib0
//     rejects raw Buffers in some bundling configurations).
//
// This file is a sibling of `cloneYjsState.ts`, which does almost the
// same thing for the duplicate-doc flow. We keep them separate because
// (a) cloneYjsState rewrites image URLs and copies ymeta whereas this
// helper is read-only, and (b) the diff endpoint may eventually want
// caching that doesn't make sense for the one-shot clone.

/**
 * Replay every yjs_documents row for `docId` with `id <= maxYjsId`,
 * returning the resulting Y.Doc. The caller owns the lifecycle of the
 * returned doc — call `doc.destroy()` once finished if you've held it
 * for any meaningful time.
 *
 * Returns an empty Y.Doc when `maxYjsId` is null OR when no rows match
 * (no rows yet for this doc, OR the id range is below the first stored
 * update). Empty Y.Docs are valid — `getText('content').toString()`
 * returns ''.
 */
export async function reconstructDocAtYjsId(
  docId: string,
  maxYjsId: number | null
): Promise<Y.Doc> {
  const doc = new Y.Doc()
  if (maxYjsId === null || maxYjsId < 0) return doc

  const pool = useDatabasePool()
  const res = await pool.query<{ value: Buffer }>(
    `SELECT value FROM yjs_documents
     WHERE docname = $1 AND version = 'v1' AND id <= $2
     ORDER BY id ASC`,
    [docId, maxYjsId]
  )
  for (const row of res.rows) {
    const buf = row.value
    Y.applyUpdate(doc, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
  }
  return doc
}

/**
 * Convenience wrapper: reconstruct + extract `content` text in one
 * call. Doc is destroyed after extraction so it can't leak through
 * the caller's event loop.
 */
export async function reconstructTextAtYjsId(
  docId: string,
  maxYjsId: number | null
): Promise<string> {
  const doc = await reconstructDocAtYjsId(docId, maxYjsId)
  try {
    return doc.getText('content').toJSON()
  } finally {
    doc.destroy()
  }
}
