import * as Y from 'yjs'
import { DocumentGoneError, RowTooLargeError, type AppendResult, type YjsStore } from './yjs-store'
import type { Logger } from './logger'

// Hocuspocus ↔ `yjs_updates`: what a load and a store do for a live document.
// The SQL lives in yjs-store.ts; the env-wired instance in persistence-instance.ts.
//
// Store = append the DELTA since this process last persisted the document:
// `Y.encodeStateAsUpdate(document, persistedStateVector)`. The state vector is
// recorded at load and advanced only after an append has committed, so a
// failed or unacknowledged append is simply contained in the next one (Y.js
// updates are idempotent — a duplicate costs bytes, never content). Each
// instance appends its own deltas; two instances on one document both land
// in the log and merge on load. The delete set is always written whole (it
// does not show in the state vector), so no deletion can be missed.
//
// A store that keeps failing marks the document unsaved: it is retried in the
// background and, while unsaved, Hocuspocus is not allowed to unload it
// (`hasUnsavedChanges`, checked in `beforeUnloadDocument`) — its edits exist
// only in this process's memory. On shutdown the veto is lifted after one
// last attempt.

/** Waits between append attempts inside one store; the store hook holds the document's save mutex meanwhile. */
const STORE_RETRY_DELAYS_MS = [250, 1000, 3000]
const SLOW_MS = 1000

interface SaveMutex {
  runExclusive<T>(fn: () => Promise<T>): Promise<T>
}

/** The Hocuspocus Document is a Y.Doc with a save mutex. */
export type LiveDocument = Y.Doc & { saveMutex?: SaveMutex }

export interface PersistenceStats {
  loads: number
  loadMs: number
  loadBytes: number
  stores: number
  storeMs: number
  storeBytes: number
  storeFailures: number
  maxStoreMs: number
}

function emptyStats(): PersistenceStats {
  return { loads: 0, loadMs: 0, loadBytes: 0, stores: 0, storeMs: 0, storeBytes: 0, storeFailures: 0, maxStoreMs: 0 }
}

export interface DocumentPersistenceDeps {
  store: YjsStore
  log: Logger
  capture: (e: unknown, tags: Record<string, string>) => void
  /** A document has accumulated this many updates since its newest snapshot. */
  snapshotThreshold: number
  onSnapshotDue: (docId: string) => void
  retryDelaysMs?: number[]
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export function createDocumentPersistence(deps: DocumentPersistenceDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = deps.now ?? (() => performance.now())
  const retryDelays = deps.retryDelaysMs ?? STORE_RETRY_DELAYS_MS
  // What this process knows to be in the table, per live document.
  const persisted = new WeakMap<Y.Doc, Uint8Array>()
  const sinceSnapshot = new WeakMap<Y.Doc, number>()
  const unsaved = new Map<Y.Doc, string>()
  let stats = emptyStats()
  let shuttingDown = false

  function countUpdate(docId: string, document: Y.Doc, added: number): void {
    const n = (sinceSnapshot.get(document) ?? 0) + added
    if (n > deps.snapshotThreshold) {
      sinceSnapshot.set(document, 0)
      deps.onSnapshotDue(docId)
    } else {
      sinceSnapshot.set(document, n)
    }
  }

  /** One append of everything not yet persisted. Throws on failure. */
  async function appendDelta(docId: string, document: Y.Doc): Promise<AppendResult> {
    const known = persisted.get(document)
    // Encoded together, with no await in between: the delta and the state
    // vector describe the same moment.
    const update = known ? Y.encodeStateAsUpdate(document, known) : Y.encodeStateAsUpdate(document)
    const stateVector = Y.encodeStateVector(document)
    const t0 = now()
    const result = await deps.store.append(docId, update)
    const ms = now() - t0
    persisted.set(document, stateVector)
    stats.stores++
    stats.storeMs += ms
    stats.storeBytes += update.byteLength
    stats.maxStoreMs = Math.max(stats.maxStoreMs, ms)
    const level = ms > SLOW_MS ? 'warn' : 'debug'
    deps.log[level]('stored document', { docId, id: result.id, bytes: update.byteLength, durationMs: Math.round(ms) })
    countUpdate(docId, document, 1)
    return result
  }

  /** A failure that retrying cannot fix: the edit is dropped, the document stays usable. */
  function isFinal(e: unknown): boolean {
    return e instanceof DocumentGoneError || e instanceof RowTooLargeError
  }

  function reportFinal(docId: string, e: unknown): void {
    if (e instanceof DocumentGoneError) {
      // Deleted while open: its rows went with the documents row and must
      // not come back. Expected around a delete, so not an error.
      deps.log.info('document deleted, not storing', { docId })
      return
    }
    deps.log.error('store refused', { docId, err: e })
    deps.capture(e, { component: 'persistence', event: 'store_refused', docId })
  }

  return {
    /**
     * Load a document. Throws on a database error so Hocuspocus refuses the
     * connection: answering with an empty document would let clients' state
     * look new and hide the real one until the next load.
     */
    async load(docId: string, document: Y.Doc): Promise<Y.Doc> {
      const t0 = now()
      try {
        const loaded = await deps.store.load(docId)
        const ms = now() - t0
        if (loaded.unreadableRowIds.length > 0) {
          const e = new Error(`unreadable Y.js rows ${loaded.unreadableRowIds.join(', ')} of ${docId}`)
          deps.log.error('skipped unreadable rows', { docId, rows: loaded.unreadableRowIds })
          deps.capture(e, { component: 'persistence', event: 'unreadable_rows', docId })
        }
        // Hocuspocus applies the loaded state into `document`, so both have
        // this state vector.
        persisted.set(document, Y.encodeStateVector(loaded.doc))
        sinceSnapshot.set(document, 0)
        countUpdate(docId, document, loaded.updatesSinceSnapshot)
        stats.loads++
        stats.loadMs += ms
        stats.loadBytes += loaded.bytes
        const level = ms > SLOW_MS ? 'warn' : 'debug'
        deps.log[level]('loaded document', { docId, bytes: loaded.bytes, updates: loaded.updatesSinceSnapshot, durationMs: Math.round(ms) })
        return loaded.doc
      } catch (e) {
        deps.log.error('load failed', { docId, err: e })
        deps.capture(e, { component: 'persistence', event: 'load_failed', docId })
        throw e
      }
    },

    /**
     * Store what changed since the last store. Retries a few times; returns
     * the appended row (for the activity log's boundary ids) or null when
     * nothing could be written — then the document stays marked unsaved and
     * `retryUnsaved` keeps trying.
     */
    async store(docId: string, document: LiveDocument): Promise<AppendResult | null> {
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await appendDelta(docId, document)
          unsaved.delete(document)
          return result
        } catch (e) {
          if (isFinal(e)) {
            unsaved.delete(document)
            reportFinal(docId, e)
            return null
          }
          const delay = retryDelays[attempt]
          if (delay === undefined) {
            stats.storeFailures++
            unsaved.set(document, docId)
            deps.log.error('store failed, keeping the document in memory', { docId, attempts: attempt + 1, err: e })
            deps.capture(e, { component: 'persistence', event: 'store_failed', docId })
            return null
          }
          deps.log.warn('store failed, retrying', { docId, attempt: attempt + 1, err: e })
          await sleep(delay)
        }
      }
    },

    /** True while the document holds edits that are not in the table. */
    hasUnsavedChanges(document: Y.Doc): boolean {
      return !shuttingDown && unsaved.has(document)
    },

    /**
     * Try once more to store every unsaved document (under its save mutex,
     * so it never overlaps a Hocuspocus store). `onSaved` runs for each
     * document that is now saved (the caller unloads it if nobody is
     * connected).
     */
    async retryUnsaved(onSaved: (docId: string, document: LiveDocument) => void): Promise<void> {
      for (const [doc, docId] of [...unsaved]) {
        // Only documents passed to `store` are in the map: Hocuspocus Documents.
        const document = doc as LiveDocument
        const run = async () => {
          try {
            await appendDelta(docId, document)
            unsaved.delete(document)
            deps.log.info('stored document after earlier failures', { docId })
            onSaved(docId, document)
          } catch (e) {
            if (isFinal(e)) {
              unsaved.delete(document)
              reportFinal(docId, e)
              onSaved(docId, document)
            } else {
              deps.log.warn('retry of unsaved document failed', { docId, err: e })
            }
          }
        }
        await (document.saveMutex ? document.saveMutex.runExclusive(run) : run())
      }
    },

    unsavedDocumentIds(): string[] {
      return [...unsaved.values()]
    },

    /** Stop vetoing unloads: shutdown must finish even if the database is gone. */
    beginShutdown(): void {
      shuttingDown = true
    },

    /** Counters since the previous call. */
    takeStats(): PersistenceStats {
      const s = stats
      stats = emptyStats()
      return s
    }
  }
}
