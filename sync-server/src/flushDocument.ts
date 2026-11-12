// Force a pending store of a loaded document, used by the app right
// before it reads the persisted Y.js state of a live document
// (`POST /api/docs/:id/duplicate` copies its `yjs_updates` state).
//
// Hocuspocus debounces `onStoreDocument` (2 s, up to 10 s under steady
// typing: see `debounce` / `maxDebounce` in index.ts). Without this, a
// duplicate made right after an edit would clone the rows from before it.
//
// Pure over a structural instance shape (no persistence import) so the
// unit tests can drive it with a fake debouncer.

export interface StoreDebouncer {
  isDebounced(id: string): boolean
  isCurrentlyExecuting(id: string): boolean
  executeNow(id: string): unknown
}

export interface FlushableInstance {
  documents?: Map<string, unknown>
  debouncer?: StoreDebouncer
}

export type FlushOutcome = 'flushed' | 'idle' | 'not-loaded'

export interface FlushOptions {
  /** How long to wait for a store that is already running. */
  timeoutMs?: number
  pollMs?: number
}

/** The id Hocuspocus' debouncer uses for a document's store. */
export function storeDebounceId(docId: string): string {
  return `onStoreDocument-${docId}`
}

/**
 * Run the document's debounced store now (if one is pending) and wait
 * for any store already in flight, so the rows in `yjs_updates` hold
 * everything this instance has received. Resolves:
 *   - `not-loaded`: no client has the doc open here, the rows are
 *     already complete (a doc is stored before it is unloaded);
 *   - `idle`: loaded, nothing pending;
 *   - `flushed`: a pending or running store finished.
 * Rejects when a running store doesn't finish within `timeoutMs`.
 */
export async function flushPendingStore(
  instance: FlushableInstance,
  docId: string,
  opts: FlushOptions = {}
): Promise<FlushOutcome> {
  if (!instance.documents?.has(docId)) return 'not-loaded'
  const debouncer = instance.debouncer
  if (!debouncer) return 'idle'
  const id = storeDebounceId(docId)
  let flushed = false
  if (debouncer.isDebounced(id)) {
    await debouncer.executeNow(id)
    flushed = true
  }
  const timeoutMs = opts.timeoutMs ?? 10_000
  const pollMs = opts.pollMs ?? 25
  const deadline = Date.now() + timeoutMs
  while (debouncer.isCurrentlyExecuting(id)) {
    if (Date.now() > deadline) throw new Error(`store of ${docId} still running after ${timeoutMs}ms`)
    await new Promise(resolve => setTimeout(resolve, pollMs))
    flushed = true
  }
  return flushed ? 'flushed' : 'idle'
}
