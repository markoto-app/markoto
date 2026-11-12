import { describe, it, expect, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import * as Y from '../../sync-server/src/yjs'
import { readYjsRows, resetDb, testDb } from '../integration/setup/db'
import { createDoc } from '../integration/setup/fixtures'
import {
  createYjsStore,
  DocumentGoneError,
  RowTooLargeError,
  YJS_LOCK_NAMESPACE as SYNC_LOCK_NAMESPACE,
  type PoolLike
} from '../../sync-server/src/yjs-store'
import { createDocumentPersistence, type LiveDocument } from '../../sync-server/src/persistence'
import { createCompactionSweeper } from '../../sync-server/src/compaction'
import {
  latestYjsId,
  readAllYjsUpdates,
  readYjsUpdatesAt,
  YjsHistoryCompactedError,
  YJS_LOCK_NAMESPACE as APP_LOCK_NAMESPACE
} from '../../server/utils/documents/yjsLog'
import type { Logger } from '../../shared/logging/core'

// Durability of the Y.js log (`yjs_updates`) against the real test Postgres:
// the sync server's store (sync-server/src/yjs-store.ts), its Hocuspocus-facing
// persistence (persistence.ts), compaction (compaction.ts) and the app's
// reader (server/utils/documents/yjsLog.ts) on the same rows.
//
// The first block (round trip / many stores / two instances / increasing
// ids) was run green against the y-postgresql implementation before it was
// replaced, with the same assertions.

const MAX_ROW_BYTES = 64 * 1024

const silent: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  with: () => silent
}

function pool(): PoolLike {
  return testDb() as unknown as PoolLike
}

function newStore(p: PoolLike = pool()) {
  return createYjsStore(p, { maxRowBytes: MAX_ROW_BYTES })
}

interface Harness {
  persistence: ReturnType<typeof createDocumentPersistence>
  snapshotDue: string[]
  captured: unknown[]
}

/** One "sync server instance": its own persistence state over the shared table. */
function instance(p: PoolLike = pool(), opts: { threshold?: number } = {}): Harness {
  const snapshotDue: string[] = []
  const captured: unknown[] = []
  const persistence = createDocumentPersistence({
    store: newStore(p),
    log: silent,
    capture: e => captured.push(e),
    snapshotThreshold: opts.threshold ?? 1000,
    onSnapshotDue: id => snapshotDue.push(id),
    retryDelaysMs: [1, 1],
    sleep: () => Promise.resolve()
  })
  return { persistence, snapshotDue, captured }
}

/** What Hocuspocus does with the loaded doc: apply it into its own Document. */
async function open(h: Harness, docId: string): Promise<LiveDocument> {
  const document = new Y.Doc() as LiveDocument
  const loaded = await h.persistence.load(docId, document)
  Y.applyUpdate(document, Y.encodeStateAsUpdate(loaded))
  loaded.destroy()
  return document
}

async function loadFresh(docId: string): Promise<Y.Doc> {
  return (await newStore().load(docId)).doc
}

function text(doc: Y.Doc): string {
  return doc.getText('content').toJSON()
}

function sameState(a: Y.Doc, b: Y.Doc): void {
  expect(text(a)).toBe(text(b))
  expect(Y.encodeStateVector(a)).toEqual(Y.encodeStateVector(b))
  expect(a.getMap('meta').toJSON()).toEqual(b.getMap('meta').toJSON())
}

/** The app's replay of the state at `id`. */
async function appTextAt(docId: string, id: number): Promise<string> {
  const doc = new Y.Doc()
  for (const u of await readYjsUpdatesAt(docId, id)) Y.applyUpdate(doc, u)
  return text(doc)
}

/** A pool whose clients fail the statement matching `failOn` (once per armed failure). */
function failingPool(failOn: RegExp, times = 1): PoolLike & { remaining: () => number } {
  const real = testDb() as Pool
  let left = times
  return {
    remaining: () => left,
    query: (text: string, values?: unknown[]) => real.query(text, values) as never,
    async connect() {
      const client = await real.connect()
      return {
        async query(text: string, values?: unknown[]) {
          if (left > 0 && failOn.test(text)) {
            left--
            throw new Error('simulated failure')
          }
          return await client.query(text, values) as never
        },
        release: (err?: Error | boolean) => client.release(err)
      }
    }
  }
}

async function backdateRows(docId: string, days: number): Promise<void> {
  await testDb().query(
    `UPDATE yjs_updates SET created_at = now() - make_interval(days => $2) WHERE doc_id = $1`,
    [docId, days]
  )
}

describe('Y.js persistence', () => {
  beforeEach(async () => {
    await resetDb()
  })

  describe('store and load', () => {
    it('round-trips a stored document', async () => {
      const h = instance()
      const { docId } = await createDoc()
      const doc = await open(h, docId)
      doc.getText('content').insert(0, 'hello')
      doc.getMap('meta').set('title', 'T')
      const stored = await h.persistence.store(docId, doc)
      expect(stored?.id).toEqual(expect.any(Number))
      sameState(await loadFresh(docId), doc)
    })

    it('many small stores load as the same document, one update row per store', async () => {
      const h = instance()
      const { docId } = await createDoc()
      const doc = await open(h, docId)
      const t = doc.getText('content')
      for (let i = 0; i < 60; i++) {
        if (i % 7 === 3 && t.length > 2) t.delete(1, 2)
        else t.insert(t.length, `line ${i}\n`)
        await h.persistence.store(docId, doc)
      }
      sameState(await loadFresh(docId), doc)
      const rows = await readYjsRows(docId)
      expect(rows).toHaveLength(60)
      expect(rows.every(r => r.kind === 'update')).toBe(true)
      // Deltas, not whole states: the last row is far smaller than the doc.
      expect(rows[59]!.data.byteLength).toBeLessThan(Y.encodeStateAsUpdate(doc).byteLength / 4)
    })

    it('a pure deletion is stored (it does not move the state vector)', async () => {
      const h = instance()
      const { docId } = await createDoc()
      const doc = await open(h, docId)
      doc.getText('content').insert(0, 'abcdef')
      await h.persistence.store(docId, doc)
      doc.getText('content').delete(1, 3)
      await h.persistence.store(docId, doc)
      expect(text(await loadFresh(docId))).toBe('aef')
    })

    it('keeps the stores of two instances editing the same document', async () => {
      const a = instance()
      const b = instance()
      const { docId } = await createDoc()
      const docA = await open(a, docId)
      const docB = await open(b, docId)
      docA.getText('content').insert(0, 'from A. ')
      docB.getText('content').insert(0, 'from B. ')
      await Promise.all([a.persistence.store(docId, docA), b.persistence.store(docId, docB)])
      docA.getText('content').insert(0, 'A again. ')
      docB.getMap('meta').set('title', 'B title')
      await Promise.all([a.persistence.store(docId, docA), b.persistence.store(docId, docB)])

      const merged = new Y.Doc()
      Y.applyUpdate(merged, Y.encodeStateAsUpdate(docA))
      Y.applyUpdate(merged, Y.encodeStateAsUpdate(docB))
      const loaded = await loadFresh(docId)
      sameState(loaded, merged)
      expect(text(loaded)).toContain('from A.')
      expect(text(loaded)).toContain('from B.')
      expect(text(loaded)).toContain('A again.')
      expect(loaded.getMap('meta').get('title')).toBe('B title')
    })

    it('returns increasing ids, each store naming the previous row as its "before"', async () => {
      const a = instance()
      const b = instance()
      const { docId } = await createDoc()
      const docA = await open(a, docId)
      const docB = await open(b, docId)
      docA.getText('content').insert(0, 'a')
      const first = await a.persistence.store(docId, docA)
      docB.getText('content').insert(0, 'b')
      const second = await b.persistence.store(docId, docB)
      docA.getText('content').insert(0, 'c')
      const third = await a.persistence.store(docId, docA)
      expect(first?.previousId).toBeNull()
      expect(second!.id).toBeGreaterThan(first!.id)
      expect(second!.previousId).toBe(first!.id)
      expect(third!.previousId).toBe(second!.id)
      expect(await latestYjsId(docId)).toBe(third!.id)
    })

    it('a document without rows loads empty', async () => {
      const { docId } = await createDoc()
      const loaded = await newStore().load(docId)
      expect(text(loaded.doc)).toBe('')
      expect(loaded.updatesSinceSnapshot).toBe(0)
    })

    it('skips a row it cannot decode and loads the rest (the row stays in the table)', async () => {
      const h = instance()
      const { docId } = await createDoc()
      const doc = await open(h, docId)
      doc.getText('content').insert(0, 'readable')
      await h.persistence.store(docId, doc)
      await testDb().query(`INSERT INTO yjs_updates (doc_id, kind, data) VALUES ($1, 'update', $2)`, [docId, Buffer.from([0xff, 0xff, 0xff])])
      const fresh = instance()
      const reloaded = await open(fresh, docId)
      expect(text(reloaded)).toBe('readable')
      expect(fresh.captured).toHaveLength(1)
      expect(await readYjsRows(docId)).toHaveLength(2)
    })
  })

  describe('failures', () => {
    it('a store whose transaction fails mid-way leaves the previous state loadable and loses nothing', async () => {
      const failing = failingPool(/INSERT INTO yjs_updates/, 1)
      const h = instance(failing)
      const { docId } = await createDoc()
      const doc = await open(h, docId)
      doc.getText('content').insert(0, 'committed. ')
      // The retries in `store` are what recover here: the first INSERT
      // fails inside the locked transaction, the second attempt writes.
      doc.getText('content').insert(doc.getText('content').length, 'after a failure.')
      const stored = await h.persistence.store(docId, doc)
      expect(failing.remaining()).toBe(0)
      expect(stored).not.toBeNull()
      sameState(await loadFresh(docId), doc)
    })

    it('a failed COMMIT writes nothing, and the delta can be written again', async () => {
      const { docId } = await createDoc()
      const base = new Y.Doc()
      base.getText('content').insert(0, 'base')
      await newStore().append(docId, Y.encodeStateAsUpdate(base))
      // The COMMIT fails: the INSERT already ran inside the transaction
      // and must roll back with it.
      const before = Y.encodeStateVector(base)
      base.getText('content').insert(4, ' + retried')
      const delta = Y.encodeStateAsUpdate(base, before)
      await expect(newStore(failingPool(/^COMMIT$/, 1)).append(docId, delta)).rejects.toThrow('simulated failure')
      expect(await readYjsRows(docId)).toHaveLength(1)
      expect(text(await loadFresh(docId))).toBe('base')
      // The writer still holds the delta (its state vector did not move) and
      // writes it again.
      await newStore().append(docId, delta)
      expect(text(await loadFresh(docId))).toBe('base + retried')
    })

    it('keeps a document whose stores keep failing marked unsaved, then saves it on retry', async () => {
      const failing = failingPool(/INSERT INTO yjs_updates/, 3)
      const h = instance(failing)
      const { docId } = await createDoc()
      const doc = await open(h, docId)
      doc.getText('content').insert(0, 'only in memory')
      // Three attempts (one + two retries), all fail.
      expect(await h.persistence.store(docId, doc)).toBeNull()
      expect(h.persistence.hasUnsavedChanges(doc)).toBe(true)
      expect(h.persistence.unsavedDocumentIds()).toEqual([docId])
      expect(await readYjsRows(docId)).toHaveLength(0)

      const saved: string[] = []
      await h.persistence.retryUnsaved(id => saved.push(id))
      expect(saved).toEqual([docId])
      expect(h.persistence.hasUnsavedChanges(doc)).toBe(false)
      sameState(await loadFresh(docId), doc)
    })

    it('stops vetoing unloads once shutdown begins', async () => {
      const failing = failingPool(/INSERT INTO yjs_updates/, 3)
      const h = instance(failing)
      const { docId } = await createDoc()
      const doc = await open(h, docId)
      doc.getText('content').insert(0, 'x')
      await h.persistence.store(docId, doc)
      expect(h.persistence.hasUnsavedChanges(doc)).toBe(true)
      h.persistence.beginShutdown()
      expect(h.persistence.hasUnsavedChanges(doc)).toBe(false)
    })

    it('refuses a row over the size limit before it reaches Postgres', async () => {
      const store = newStore()
      const { docId } = await createDoc()
      await expect(store.append(docId, new Uint8Array(MAX_ROW_BYTES + 1))).rejects.toBeInstanceOf(RowTooLargeError)
      expect(await readYjsRows(docId)).toHaveLength(0)
    })

    it('an oversized document is refused without being marked unsaved', async () => {
      const h = instance()
      const { docId } = await createDoc()
      const doc = await open(h, docId)
      doc.getText('content').insert(0, 'x'.repeat(MAX_ROW_BYTES + 10))
      expect(await h.persistence.store(docId, doc)).toBeNull()
      expect(h.persistence.hasUnsavedChanges(doc)).toBe(false)
      expect(h.captured).toHaveLength(1)
      expect(await readYjsRows(docId)).toHaveLength(0)
    })
  })

  describe('deletion', () => {
    it('deleting the document deletes its Y.js rows, and a late store cannot revive them', async () => {
      const h = instance()
      const { docId } = await createDoc()
      const doc = await open(h, docId)
      doc.getText('content').insert(0, 'to be deleted')
      await h.persistence.store(docId, doc)
      expect(await readYjsRows(docId)).toHaveLength(1)

      await testDb().query('DELETE FROM documents WHERE doc_id = $1', [docId])
      expect(await readYjsRows(docId)).toHaveLength(0)

      doc.getText('content').insert(0, 'late edit ')
      expect(await h.persistence.store(docId, doc)).toBeNull()
      expect(h.persistence.hasUnsavedChanges(doc)).toBe(false)
      expect(h.captured).toHaveLength(0)
      expect(await readYjsRows(docId)).toHaveLength(0)
      await expect(newStore().append(docId, Y.encodeStateAsUpdate(doc))).rejects.toBeInstanceOf(DocumentGoneError)
    })
  })

  describe('snapshots (compaction)', () => {
    /** 30 stores with deletions; returns the text after every store, by row id. */
    async function editHistory(docId: string): Promise<{ doc: LiveDocument, textAt: Map<number, string> }> {
      const h = instance()
      const doc = await open(h, docId)
      const t = doc.getText('content')
      const textAt = new Map<number, string>()
      for (let i = 0; i < 30; i++) {
        if (i % 5 === 4) t.delete(0, 3)
        else t.insert(t.length, `step ${i}. `)
        if (i === 10) doc.getMap('meta').set('title', 'mid')
        const r = await h.persistence.store(docId, doc)
        textAt.set(r!.id, text(doc))
      }
      return { doc, textAt }
    }

    it('keeps the content identical and every id replayable, and is idempotent', async () => {
      const { docId } = await createDoc()
      const { doc, textAt } = await editHistory(docId)
      const store = newStore()

      const snap = await store.writeSnapshot(docId)
      expect(snap).not.toBeNull()
      expect(snap!.updatesMerged).toBe(30)
      sameState(await loadFresh(docId), doc)
      // Nothing deleted: every recorded id still replays to its own state.
      for (const [id, expected] of textAt) expect(await appTextAt(docId, id)).toBe(expected)
      expect(await appTextAt(docId, snap!.id)).toBe(text(doc))

      // Nothing new to fold: a second run writes nothing.
      expect(await store.writeSnapshot(docId)).toBeNull()
      expect((await readYjsRows(docId)).filter(r => r.kind === 'snapshot')).toHaveLength(1)
      // Loading now reads only the snapshot.
      expect((await store.load(docId)).updatesSinceSnapshot).toBe(0)
    })

    it('is safe when two workers snapshot the same document at once', async () => {
      const { docId } = await createDoc()
      const { doc } = await editHistory(docId)
      const results = await Promise.all([newStore().writeSnapshot(docId), newStore().writeSnapshot(docId)])
      expect(results.filter(r => r !== null)).toHaveLength(1)
      expect((await readYjsRows(docId)).filter(r => r.kind === 'snapshot')).toHaveLength(1)
      sameState(await loadFresh(docId), doc)
    })

    it('stays correct while stores keep landing during the snapshot', async () => {
      const { docId } = await createDoc()
      const h = instance()
      const doc = await open(h, docId)
      for (let i = 0; i < 20; i++) {
        doc.getText('content').insert(0, `${i},`)
        await h.persistence.store(docId, doc)
      }
      const writer = (async () => {
        for (let i = 20; i < 40; i++) {
          doc.getText('content').insert(0, `${i},`)
          await h.persistence.store(docId, doc)
        }
      })()
      const snaps = await Promise.all([newStore().writeSnapshot(docId), writer.then(() => newStore().writeSnapshot(docId))])
      expect(snaps.some(s => s !== null)).toBe(true)
      sameState(await loadFresh(docId), doc)
      // The snapshot covers exactly the rows below it.
      const rows = await readYjsRows(docId)
      for (const snapRow of rows.filter(r => r.kind === 'snapshot')) {
        const below = new Y.Doc()
        for (const r of rows.filter(x => x.id < snapRow.id)) Y.applyUpdate(below, r.data)
        const fromSnap = new Y.Doc()
        Y.applyUpdate(fromSnap, snapRow.data)
        sameState(fromSnap, below)
      }
    })

    it('the persistence queues a document once it passes the threshold', async () => {
      const h = instance(pool(), { threshold: 5 })
      const { docId } = await createDoc()
      const doc = await open(h, docId)
      for (let i = 0; i < 6; i++) {
        doc.getText('content').insert(0, 'x')
        await h.persistence.store(docId, doc)
      }
      expect(h.snapshotDue).toEqual([docId])
      // A fresh load of a document already past the threshold queues it too.
      const other = instance(pool(), { threshold: 5 })
      await open(other, docId)
      expect(other.snapshotDue).toEqual([docId])
    })
  })

  describe('pruning (COMPACT_RETAIN_HISTORY_DAYS)', () => {
    it('removes rows below an old snapshot; ids from the snapshot on replay, older ids fail cleanly', async () => {
      const { docId } = await createDoc()
      const h = instance()
      const doc = await open(h, docId)
      const ids: number[] = []
      const texts: string[] = []
      for (let i = 0; i < 10; i++) {
        doc.getText('content').insert(doc.getText('content').length, `${i};`)
        ids.push((await h.persistence.store(docId, doc))!.id)
        texts.push(text(doc))
      }
      const store = newStore()
      const snap = (await store.writeSnapshot(docId))!
      await backdateRows(docId, 40)
      for (let i = 10; i < 13; i++) {
        doc.getText('content').insert(doc.getText('content').length, `${i};`)
        ids.push((await h.persistence.store(docId, doc))!.id)
        texts.push(text(doc))
      }
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

      expect(await store.pruneCandidates(cutoff, 10)).toEqual([docId])
      expect(await store.prune(docId, cutoff)).toBe(10)
      expect(await store.prune(docId, cutoff)).toBe(0)
      expect(await store.pruneCandidates(cutoff, 10)).toEqual([])

      sameState(await loadFresh(docId), doc)
      expect(await appTextAt(docId, snap.id)).toBe(texts[9])
      for (let i = 10; i < 13; i++) expect(await appTextAt(docId, ids[i]!)).toBe(texts[i])
      await expect(readYjsUpdatesAt(docId, ids[3]!)).rejects.toBeInstanceOf(YjsHistoryCompactedError)
      await expect(readYjsUpdatesAt(docId, ids[3]!)).rejects.toMatchObject({ floorId: snap.id })
      // The image GC still walks every remaining state.
      expect(await readAllYjsUpdates(docId)).toHaveLength(4)
    })

    it('keeps everything while the snapshot is younger than the retention window', async () => {
      const { docId } = await createDoc()
      const h = instance()
      const doc = await open(h, docId)
      for (let i = 0; i < 5; i++) {
        doc.getText('content').insert(0, 'y')
        await h.persistence.store(docId, doc)
      }
      const store = newStore()
      await store.writeSnapshot(docId)
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      expect(await store.prune(docId, cutoff)).toBe(0)
      expect(await readYjsRows(docId)).toHaveLength(6)
    })

    it('the sweep snapshots queued documents and prunes only with a retention set', async () => {
      const { docId } = await createDoc()
      const h = instance()
      const doc = await open(h, docId)
      for (let i = 0; i < 5; i++) {
        doc.getText('content').insert(0, 'z')
        await h.persistence.store(docId, doc)
      }
      const keepAll = createCompactionSweeper({
        store: newStore(), pool: pool(), log: silent, capture: () => {},
        intervalMs: 0, maxDocsPerRun: 10, retainHistoryDays: 0
      })
      keepAll.enqueue(docId)
      expect(await keepAll.runOnce()).toMatchObject({ snapshots: 1, pruned: 0, skipped: false })
      expect(keepAll.queued()).toEqual([])
      await backdateRows(docId, 40)
      expect(await keepAll.runOnce()).toMatchObject({ snapshots: 0, pruned: 0 })
      expect(await readYjsRows(docId)).toHaveLength(6)

      const retain30 = createCompactionSweeper({
        store: newStore(), pool: pool(), log: silent, capture: () => {},
        intervalMs: 0, maxDocsPerRun: 10, retainHistoryDays: 30
      })
      expect(await retain30.runOnce()).toMatchObject({ pruned: 1, rowsDeleted: 5 })
      sameState(await loadFresh(docId), doc)
    })
  })

  describe('history replay and restore', () => {
    it('restore to an id produces the document as of that id, and is itself reversible', async () => {
      const { docId } = await createDoc()
      const h = instance()
      const doc = await open(h, docId)
      doc.getText('content').insert(0, 'version one')
      const v1 = (await h.persistence.store(docId, doc))!
      doc.getText('content').insert(doc.getText('content').length, ', then two')
      const v2 = (await h.persistence.store(docId, doc))!
      expect(await appTextAt(docId, v1.id)).toBe('version one')

      // What restoreDocToYjsId does: read the target state, then replace
      // the live text in one transaction (a normal edit, appended).
      const restore = async (target: number) => {
        const past = await appTextAt(docId, target)
        doc.transact(() => {
          const t = doc.getText('content')
          t.delete(0, t.length)
          t.insert(0, past)
        })
        return (await h.persistence.store(docId, doc))!
      }
      const r1 = await restore(v1.id)
      expect(r1.previousId).toBe(v2.id)
      expect(text(await loadFresh(docId))).toBe('version one')
      // The restore row's "before" brings the pre-restore state back.
      const r2 = await restore(r1.previousId!)
      expect(text(await loadFresh(docId))).toBe('version one, then two')
      expect(await appTextAt(docId, r2.previousId!)).toBe('version one')
      // Snapshotting changes none of it.
      await newStore().writeSnapshot(docId)
      expect(await appTextAt(docId, v1.id)).toBe('version one')
      expect(await appTextAt(docId, v2.id)).toBe('version one, then two')
    })

    it('an id below the first row of an unpruned document is the empty state', async () => {
      const { docId } = await createDoc()
      const h = instance()
      const doc = await open(h, docId)
      doc.getText('content').insert(0, 'x')
      const first = (await h.persistence.store(docId, doc))!
      expect(await readYjsUpdatesAt(docId, first.id - 1)).toEqual([])
    })

    it('the app and the sync server use the same lock and read the same state', async () => {
      expect(APP_LOCK_NAMESPACE).toBe(SYNC_LOCK_NAMESPACE)
      const { docId } = await createDoc()
      const h = instance()
      const doc = await open(h, docId)
      doc.getText('content').insert(0, 'same')
      await h.persistence.store(docId, doc)
      await newStore().writeSnapshot(docId)
      doc.getText('content').insert(0, 'the ')
      await h.persistence.store(docId, doc)
      expect(await appTextAt(docId, (await latestYjsId(docId))!)).toBe(text(await loadFresh(docId)))
    })
  })
})
