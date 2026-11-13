// The sync server's persistence decisions without a database: what a store
// writes, how failures are retried / kept in memory, and how the compaction
// sweep schedules work. The SQL itself runs against Postgres in
// tests/repos/yjsPersistence.test.ts.

import { describe, it, expect } from 'vitest'
import * as Y from '../../../sync-server/src/yjs'
import { createDocumentPersistence, type LiveDocument } from '../../../sync-server/src/persistence'
import { createCompactionSweeper } from '../../../sync-server/src/compaction'
import { DocumentGoneError, type PoolLike, type YjsStore } from '../../../sync-server/src/yjs-store'
import type { Logger } from '../../../shared/logging/core'

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, with: () => silent }

/** An in-memory stand-in for the store: an array of appended updates. */
function fakeStore(failures: Array<Error | null> = []) {
  const rows: Uint8Array[] = []
  const snapshots: string[] = []
  const store = {
    load: async () => {
      const doc = new Y.Doc()
      for (const r of rows) Y.applyUpdate(doc, r)
      return { doc, updatesSinceSnapshot: rows.length, bytes: 0, unreadableRowIds: [] }
    },
    append: async (_docId: string, update: Uint8Array) => {
      const failure = failures.shift()
      if (failure) throw failure
      rows.push(update)
      return { id: rows.length, previousId: rows.length > 1 ? rows.length - 1 : null }
    },
    writeSnapshot: async (docId: string) => {
      if (docId === 'broken') throw new Error('boom')
      snapshots.push(docId)
      return { id: 1, updatesMerged: 2, bytes: 1 }
    },
    prune: async () => 0,
    pruneCandidates: async () => []
  } satisfies YjsStore
  return { store, rows, snapshots }
}

function persistenceWith(store: YjsStore, captured: unknown[] = []) {
  const due: string[] = []
  const p = createDocumentPersistence({
    store,
    log: silent,
    capture: e => captured.push(e),
    snapshotThreshold: 2,
    onSnapshotDue: id => due.push(id),
    retryDelaysMs: [1],
    sleep: () => Promise.resolve()
  })
  return { p, due }
}

function textOf(rows: Uint8Array[]): string {
  const doc = new Y.Doc()
  for (const r of rows) Y.applyUpdate(doc, r)
  return doc.getText('content').toJSON()
}

describe('document persistence', () => {
  it('stores only what changed since the previous store', async () => {
    const { store, rows } = fakeStore()
    const { p } = persistenceWith(store)
    const doc = new Y.Doc() as LiveDocument
    await p.load('d', doc)
    doc.getText('content').insert(0, 'a'.repeat(500))
    await p.store('d', doc)
    doc.getText('content').insert(0, 'b')
    await p.store('d', doc)
    expect(rows).toHaveLength(2)
    expect(rows[1]!.byteLength).toBeLessThan(100)
    expect(textOf(rows)).toBe(`b${'a'.repeat(500)}`)
  })

  it('a store that fails and then succeeds writes the whole missed delta', async () => {
    const { store, rows } = fakeStore([new Error('connection reset')])
    const { p } = persistenceWith(store)
    const doc = new Y.Doc() as LiveDocument
    await p.load('d', doc)
    doc.getText('content').insert(0, 'kept')
    expect(await p.store('d', doc)).toEqual({ id: 1, previousId: null })
    expect(textOf(rows)).toBe('kept')
  })

  it('keeps a document unsaved after its retries, and saves it under its save mutex later', async () => {
    const { store, rows } = fakeStore([new Error('down'), new Error('down')])
    const captured: unknown[] = []
    const { p } = persistenceWith(store, captured)
    const doc = new Y.Doc() as LiveDocument
    const order: string[] = []
    doc.saveMutex = {
      runExclusive: async <T>(fn: () => Promise<T>) => {
        order.push('locked')
        return fn()
      }
    }
    await p.load('d', doc)
    doc.getText('content').insert(0, 'precious')
    expect(await p.store('d', doc)).toBeNull()
    expect(p.hasUnsavedChanges(doc)).toBe(true)
    expect(captured).toHaveLength(1)

    const saved: string[] = []
    await p.retryUnsaved(id => saved.push(id))
    expect(order).toEqual(['locked'])
    expect(saved).toEqual(['d'])
    expect(p.hasUnsavedChanges(doc)).toBe(false)
    expect(textOf(rows)).toBe('precious')
  })

  it('drops the edits of a deleted document without retrying or reporting it', async () => {
    const { store } = fakeStore([new DocumentGoneError('d')])
    const captured: unknown[] = []
    const { p } = persistenceWith(store, captured)
    const doc = new Y.Doc() as LiveDocument
    await p.load('d', doc)
    doc.getText('content').insert(0, 'x')
    expect(await p.store('d', doc)).toBeNull()
    expect(p.hasUnsavedChanges(doc)).toBe(false)
    expect(captured).toHaveLength(0)
  })

  it('rethrows a load failure (Hocuspocus then refuses the connection)', async () => {
    const { store } = fakeStore()
    const failing = {
      ...store,
      load: async () => {
        throw new Error('db down')
      }
    }
    const { p } = persistenceWith(failing)
    await expect(p.load('d', new Y.Doc())).rejects.toThrow('db down')
  })

  it('asks for a snapshot once the updates since the last one pass the threshold', async () => {
    const { store } = fakeStore()
    const { p, due } = persistenceWith(store)
    const doc = new Y.Doc() as LiveDocument
    await p.load('d', doc)
    for (let i = 0; i < 3; i++) {
      doc.getText('content').insert(0, 'x')
      await p.store('d', doc)
    }
    expect(due).toEqual(['d'])
  })
})

describe('compaction sweeper', () => {
  function lockPool(locked: boolean): PoolLike {
    const query = async <R>(text: string) => {
      const rows = text.includes('pg_try_advisory_lock') ? [{ locked }] : []
      return { rows: rows as R[], rowCount: 0 }
    }
    return { query, connect: async () => ({ query, release: () => {} }) }
  }

  it('snapshots queued documents, at most maxDocsPerRun, and one failure does not stop the rest', async () => {
    const { store, snapshots } = fakeStore()
    const sweeper = createCompactionSweeper({
      store, pool: lockPool(true), log: silent, capture: () => {},
      intervalMs: 0, maxDocsPerRun: 2, retainHistoryDays: 0
    })
    for (const id of ['broken', 'a', 'b']) sweeper.enqueue(id)
    expect(await sweeper.runOnce()).toMatchObject({ snapshots: 1, skipped: false })
    expect(snapshots).toEqual(['a'])
    expect(sweeper.queued()).toEqual(['b'])
  })

  it('skips the run while another instance holds the sweep lock', async () => {
    const { store, snapshots } = fakeStore()
    const sweeper = createCompactionSweeper({
      store, pool: lockPool(false), log: silent, capture: () => {},
      intervalMs: 0, maxDocsPerRun: 5, retainHistoryDays: 0
    })
    sweeper.enqueue('a')
    expect(await sweeper.runOnce()).toMatchObject({ skipped: true })
    expect(snapshots).toEqual([])
    expect(sweeper.queued()).toEqual(['a'])
  })
})
