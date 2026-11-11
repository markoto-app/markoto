import * as Y from 'yjs'
import { useDatabasePool } from '../platform/database'

// Reconstruct a Y.Doc's state at a specific point in its history by
// replaying every y-postgresql update row up to (and including) a
// given `id`. Used by the activity-log diff endpoint to materialize
// the doc on either side of an `edit` event so we can compute a
// textual diff.
//
// Mechanics:
//   - y-postgresql stores granular updates as `version = 'v1'` rows in
//     `yjs_documents`; `v1_sv` rows are derived state vectors and are skipped.
//   - `Y.applyUpdate` is associative + commutative, so order does not matter
//     for correctness; rows are replayed by `id ASC` to match y-postgresql's
//     own load order and keep debugging deterministic.
//   - There is no caching: replay of the longest docs takes tens to a few
//     hundred ms.
//
// Edge cases:
//   - `maxYjsId === null` → an empty Y.Doc (the activity row has no
//     recorded boundary).
//   - `maxYjsId` references a row that has since been COMPACTED AWAY by
//     y-postgresql (`flushDocument` → `clearUpdatesRange` DELETES every
//     `v1` row below the merged row). The merged row's `id` is HIGHER
//     than `maxYjsId`, so `WHERE id <= maxYjsId` EXCLUDES it while the
//     originals it absorbed are already deleted → this returns an EMPTY
//     Y.Doc. That's lossy, not "collapsed but correct". It's harmless for
//     the read-only diff endpoint (degrades to a whole-doc diff), but a
//     DESTRUCTIVE caller must never apply an empty reconstruction over a
//     live doc — `restoreDoc.ts` guards this with a compaction-floor check
//     (`RestorePointCompactedError`) before it touches anything.
//   - Row data is a `Buffer` from pg's bytea decoder; we slice into a
//     proper Uint8Array view before passing to `applyUpdate` (lib0
//     rejects raw Buffers in some bundling configurations).
//
// Kept separate from `cloneYjsState.ts`, which replays the same way but
// rewrites image URLs and copies ymeta; this helper is read-only.

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
