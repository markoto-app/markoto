import * as Y from 'yjs'
import { latestYjsId, readYjsUpdatesAt } from './yjsLog'

// Reconstruct a Y.Doc's state at a specific point in its history: the
// document's `yjs_updates` rows up to (and including) a given id, starting
// from the newest snapshot at or below it (`readYjsUpdatesAt`, yjsLog.ts).
// Used by the activity-log diff and restore, the server render and the
// data export.
//
// Edge cases:
//   - `maxYjsId === null` → an empty Y.Doc (the activity row has no
//     recorded boundary). It never means "latest": the current state is
//     `reconstructCurrentDoc`.
//   - `maxYjsId` below the document's first row → an empty Y.Doc: the state
//     before the first write.
//   - `maxYjsId` below the history floor (rows pruned by the sync server's
//     COMPACT_RETAIN_HISTORY_DAYS) → `YjsHistoryCompactedError`. Never an
//     empty doc: a restore applying one would wipe the live document.
//
// Kept separate from `cloneYjsState.ts`, which replays the same way but
// rewrites image URLs and copies ymeta; this helper is read-only.

/**
 * The document's state at `maxYjsId`. The caller owns the lifecycle of the
 * returned doc — call `doc.destroy()` once finished if you've held it for
 * any meaningful time.
 */
export async function reconstructDocAtYjsId(
  docId: string,
  maxYjsId: number | null
): Promise<Y.Doc> {
  const doc = new Y.Doc()
  if (maxYjsId === null || maxYjsId < 0) return doc

  const updates = await readYjsUpdatesAt(docId, maxYjsId)
  doc.transact(() => {
    for (const update of updates) Y.applyUpdate(doc, update)
  })
  return doc
}

/**
 * The document's current stored state (its newest row). Call
 * `flushSyncDocument` first when edits still pending in the sync server
 * must be included. The caller destroys the returned doc.
 */
export async function reconstructCurrentDoc(docId: string): Promise<Y.Doc> {
  return reconstructDocAtYjsId(docId, await latestYjsId(docId))
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
