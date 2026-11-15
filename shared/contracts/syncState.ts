// Valkey keys of the sync server's per-document state (attribution and
// diff baselines, `sync-server/src/sync-state.ts`). Shared so the app can
// delete a document's state when it deletes the document: the sync server
// only drops it when it unloads the document, which it never does for a
// document that isn't open there.
//
// Dependency-free: imported by the sync server and the app.

export const syncStateKeys = {
  lastEditor: (docId: string) => `sync:last-editor:${docId}`,
  prevLines: (docId: string) => `sync:prev-lines:${docId}`,
  prevMeta: (docId: string) => `sync:prev-meta:${docId}`
} as const

/** Every per-document key, for deletion. */
export function allSyncStateKeys(docId: string): string[] {
  return [syncStateKeys.lastEditor(docId), syncStateKeys.prevLines(docId), syncStateKeys.prevMeta(docId)]
}
