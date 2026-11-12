import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { first } from '../../helpers/assert'
import { stubEnv } from '../../helpers/env'
import { docAs } from '../../helpers/access'

// Mocks have to register BEFORE the import of `restoreDoc.ts` —
// vitest hoists `vi.mock` calls automatically, but the factory
// closures still need to capture mutable refs we can drive from
// each test.

// HocuspocusProvider mock
//
// We replace the class with one that records constructor options +
// exposes manual triggers for sync / auth-fail / close. Tests drive
// the lifecycle deterministically rather than waiting for real WS.
const providerCalls: Array<{
  url: string
  name: string
  token: string
  document: Y.Doc
  options: Record<string, unknown>
}> = []
const providerInstances: MockProvider[] = []

interface MockProviderOptions {
  url: string
  name: string
  document: Y.Doc
  token: string
  awareness?: unknown
  onSynced?: () => void
  onAuthenticationFailed?: (d: { reason: string }) => void
  onClose?: (d: { event?: { code?: number, reason?: string } }) => void
}

class MockProvider {
  options: MockProviderOptions
  disconnectCalls = 0
  destroyCalls = 0
  // Default: auto-fire onSynced asynchronously so the helper sees
  // the same shape it would in production. Tests can opt out by
  // setting `autoSync = false` BEFORE constructing (via the factory
  // override in beforeEach).
  static autoSync = true
  static authFailReason: string | null = null
  static syncDelayMs = 0

  constructor(options: MockProviderOptions) {
    this.options = options
    // Snapshot how many tx.execute calls had landed at the moment
    // the provider was constructed. This is the timing pin for the
    // "yjsDocIdBefore captured BEFORE WS connect" regression test.
    txState.providerConstructedAtCallIndex = txExecuteCalls.length
    providerCalls.push({
      url: options.url,
      name: options.name,
      token: options.token,
      document: options.document,
      options: options as unknown as Record<string, unknown>
    })
    providerInstances.push(this)
    options.document.on('update', () => this.sent())

    // Schedule the async lifecycle event (sync OR auth-fail). Done
    // via setTimeout so the constructor returns first; matches real
    // behaviour where the WS handshake is async.
    setTimeout(() => {
      if (MockProvider.authFailReason) {
        options.onAuthenticationFailed?.({ reason: MockProvider.authFailReason })
        return
      }
      if (MockProvider.autoSync) {
        options.onSynced?.()
      }
    }, MockProvider.syncDelayMs)
  }

  disconnect() { this.disconnectCalls += 1 }
  destroy() { this.destroyCalls += 1 }

  // Server acknowledgement of sent updates (Hocuspocus sync-status). By
  // default every update is acknowledged as soon as it is sent; with
  // `ackDelayMs` the acknowledgement arrives later, with `neverAck` never.
  static ackDelayMs = 0
  static neverAck = false
  unsynced = 0
  private listeners: Array<() => void> = []
  get hasUnsyncedChanges() { return this.unsynced > 0 }
  on(event: string, fn: () => void) { if (event === 'unsyncedChanges') this.listeners.push(fn) }
  off(event: string, fn: () => void) { this.listeners = this.listeners.filter(l => l !== fn) }
  /** Called by the test's update hook: one update sent to the server. */
  sent() {
    this.unsynced += 1
    if (MockProvider.neverAck) return
    setTimeout(() => {
      this.unsynced -= 1
      events.push('ack')
      for (const l of [...this.listeners]) l()
    }, MockProvider.ackDelayMs)
  }
}

// Order of the observable steps after the restore transaction: the server
// ack, the flush request and the `after` id read.
const events: string[] = []

const flushMock = vi.fn(async (_docId: string) => {
  events.push('flush')
  return true
})
vi.mock('../../../server/utils/documents/syncNotify', () => ({
  flushSyncDocument: (docId: string) => flushMock(docId)
}))

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: MockProvider
}))

// useDatabase mock
//
// The helper opens a tx and runs three SQL statements via the
// `sql` template (advisory lock, SELECT MAX(id) before, SELECT
// MAX(id) after). We mock `tx.execute` to return canned MAX(id)
// values per call AND record the order of calls so tests can pin
// "before is captured before WS connect" and similar.

const txExecuteCalls: Array<{ kind: 'lock' | 'maxId', orderInTransaction: number }> = []
const txState = {
  // Driven by tests via beforeEach. The Nth `MAX(id)` SELECT returns
  // the Nth value from this array; the helper makes 2 such calls per
  // run (before + after), so this is typically [beforeId, afterId].
  maxIdValues: [] as Array<number | null>,
  maxIdCallIndex: 0,
  // Records when the WS provider was constructed relative to the
  // tx's execute calls — used to assert "yjsDocIdBefore captured
  // BEFORE the WS connect."
  providerConstructedAtCallIndex: -1
}

const dbMock = {
  transaction: vi.fn(async (fn: (tx: { execute: (q: unknown) => Promise<unknown> }) => Promise<unknown>) => {
    let callIndex = 0
    const tx = {
      execute: vi.fn(async (_q: unknown) => {
        callIndex += 1
        // The helper issues the advisory lock first, then SELECT
        // MAX(id) BEFORE, then (much later) SELECT MAX(id) AFTER.
        // We classify by call ordinal — call 1 is the lock, calls
        // 2+ are MAX(id) reads.
        if (callIndex === 1) {
          txExecuteCalls.push({ kind: 'lock', orderInTransaction: callIndex })
          return { rows: [] }
        }
        const idx = txState.maxIdCallIndex
        txState.maxIdCallIndex += 1
        events.push(`maxId#${idx}`)
        const id = txState.maxIdValues[idx] ?? null
        txExecuteCalls.push({ kind: 'maxId', orderInTransaction: callIndex })
        return { rows: [{ id }] }
      })
    }
    return await fn(tx)
  })
}

vi.mock('../../../server/db/client', () => ({
  useDatabase: () => dbMock,
  useDatabasePool: () => ({ query: vi.fn() }),
  withTransaction: (fn: Parameters<typeof dbMock.transaction>[0]) => dbMock.transaction(fn),
  executor: (tx: unknown) => tx
}))

// historyReplay mock
//
// The replay helper itself is unit-tested elsewhere; here we just
// need it to return a Y.Doc with known content so we can verify
// the "encode + apply → live doc" pipeline.
const replayMock = vi.fn()
vi.mock('../../../server/utils/documents/historyReplay', () => ({
  reconstructDocAtYjsId: (...args: unknown[]) => replayMock(...args)
}))

// Configuration comes from the typed env (shared/env), stubbed per test.
const JWT_SECRET = 'unit-test-secret-unit-test-secret-0123'
function stubConfig(jwtSecret: string | undefined, syncInternalUrl = 'http://sync:4001'): void {
  stubEnv({ NUXT_JWT_SECRET: jwtSecret, NUXT_SYNC_INTERNAL_URL: syncInternalUrl })
}

// Now safe to import the unit under test — all mocks registered.
const { restoreDocToYjsId, readRestorableMeta } = await import('../../../server/utils/documents/restoreDoc')

beforeEach(() => {
  providerCalls.length = 0
  providerInstances.length = 0
  txExecuteCalls.length = 0
  txState.maxIdValues = [100, 105] // sensible defaults: before=100, after=105
  txState.maxIdCallIndex = 0
  txState.providerConstructedAtCallIndex = -1
  MockProvider.autoSync = true
  MockProvider.authFailReason = null
  MockProvider.syncDelayMs = 0
  MockProvider.ackDelayMs = 0
  MockProvider.neverAck = false
  events.length = 0
  flushMock.mockClear()
  // Hand back a non-empty past doc by default.
  replayMock.mockReset()
  replayMock.mockImplementation((_docId: string, _maxId: number) => {
    const doc = new Y.Doc()
    doc.getText('content').insert(0, 'past content')
    return doc
  })
  stubConfig(JWT_SECRET)
})

describe('restoreDocToYjsId', () => {
  describe('config validation', () => {
    it('throws when jwtSecret is not configured', async () => {
      stubConfig(undefined)
      await expect(
        restoreDocToYjsId({ doc: docAs('d'), targetYjsId: 50, actorUserId: 1, actorName: 'A', sessionId: 's' })
      ).rejects.toThrow(/JWT secret/)
    })
  })

  describe('boundary id capture (reversibility-critical)', () => {
    it('returns the captured before/after yjs ids', async () => {
      txState.maxIdValues = [73, 76]
      const result = await restoreDocToYjsId({
        doc: docAs('doc-x'), targetYjsId: 50, actorUserId: 1, actorName: 'Joel', sessionId: 'sess1'
      })
      expect(result).toEqual({ yjsDocIdBeforeRestore: 73, yjsDocIdAfterRestore: 76 })
    })

    it('captures yjsDocIdBeforeRestore BEFORE the WS provider is constructed (regression target)', async () => {
      // SECURITY/CORRECTNESS: the helper must capture `before` BEFORE the WS sync. If it captures `before` AFTER
      // the sync, the value reflects post-restore state and reversibility breaks (clicking restore on a restore
      // row goes to the same target as the original).
      //
      // The MockProvider's constructor records how many tx.execute
      // calls had landed BEFORE it ran. By the time the provider is
      // constructed, the helper must have already issued: (1) the
      // advisory lock query and (2) the SELECT max(id) for `before` —
      // that's 2 tx.execute() calls. A smaller value means the helper is
      // reading `before` AFTER the WS connect (the reversibility bug).
      txState.maxIdValues = [40, 41]
      await restoreDocToYjsId({
        doc: docAs('doc-y'), targetYjsId: 30, actorUserId: 1, actorName: 'A', sessionId: 's'
      })
      expect(txState.providerConstructedAtCallIndex).toBe(2)
    })

    it('reads the after id only once the server acknowledged the update and stored the document', async () => {
      // The sync server debounces its store by 2 s; reading max(id) before
      // it stored would stamp the restore row with the pre-restore id
      // (after == before) and its diff / undo would show nothing.
      MockProvider.ackDelayMs = 30
      await restoreDocToYjsId({ doc: docAs('doc-x'), targetYjsId: 50, actorUserId: 1, actorName: 'Joel', sessionId: 's' })
      expect(events).toEqual(['maxId#0', 'ack', 'flush', 'maxId#1'])
      expect(flushMock).toHaveBeenCalledWith('doc-x')
      expect(first(providerInstances).disconnectCalls).toBe(1)
    })

    it('fails (and still disconnects) when the server never acknowledges the update', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        MockProvider.neverAck = true
        const run = restoreDocToYjsId({ doc: docAs('d'), targetYjsId: 1, actorUserId: 1, actorName: 'A', sessionId: 's' })
          .then(() => null, (e: unknown) => e)
        await vi.advanceTimersByTimeAsync(10_001)
        expect(String(await run)).toMatch(/not acknowledged/)
        expect(flushMock).not.toHaveBeenCalled()
        expect(first(providerInstances).disconnectCalls).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('returns null for both ids when MAX(id) is null (empty doc, no rows yet)', async () => {
      txState.maxIdValues = [null, null]
      const result = await restoreDocToYjsId({
        doc: docAs('d'), targetYjsId: 0, actorUserId: 1, actorName: 'A', sessionId: 's'
      })
      expect(result).toEqual({ yjsDocIdBeforeRestore: null, yjsDocIdAfterRestore: null })
    })
  })

  describe('JWT identity', () => {
    it('signs the JWT with the synthetic restore principal', async () => {
      // The principal format `restore:{userId}:{sessionId}` is what
      // sync-server's onChange hook uses to attribute the activity
      // row to the right user. A typo here breaks every consumer.
      await restoreDocToYjsId({
        doc: docAs('d'), targetYjsId: 1, actorUserId: 42, actorName: 'Joel', sessionId: 'abc123'
      })
      expect(providerCalls).toHaveLength(1)
      const jwtModule = await import('jsonwebtoken')
      const decoded = jwtModule.default.decode(first(providerCalls).token) as Record<string, unknown>
      expect(decoded.userId).toBe('restore:42:abc123')
      expect(decoded.userName).toBe('Joel')
      expect(decoded.docId).toBe('d')
      expect(decoded.readOnly).toBe(false)
    })

    it('passes the live doc name as the WS provider `name`', async () => {
      await restoreDocToYjsId({
        doc: docAs('doc-target'), targetYjsId: 1, actorUserId: 1, actorName: 'A', sessionId: 's'
      })
      expect(first(providerCalls).name).toBe('doc-target')
    })

    it('converts http:// syncInternalUrl to ws:// for the WS connection', async () => {
      stubConfig(JWT_SECRET, 'http://sync:4001')
      await restoreDocToYjsId({
        doc: docAs('d'), targetYjsId: 1, actorUserId: 1, actorName: 'A', sessionId: 's'
      })
      expect(first(providerCalls).url).toBe('ws://sync:4001')
    })

    it('converts https:// syncInternalUrl to wss:// for TLS', async () => {
      stubConfig(JWT_SECRET, 'https://sync.prod:443')
      await restoreDocToYjsId({
        doc: docAs('d'), targetYjsId: 1, actorUserId: 1, actorName: 'A', sessionId: 's'
      })
      expect(first(providerCalls).url).toBe('wss://sync.prod:443')
    })
  })

  describe('Y.js application', () => {
    it('passes the past doc\'s state to applyUpdate via the live ydoc', async () => {
      // The fixture: replayed past doc has "past content" in its
      // ytext. After the helper runs, the LIVE ydoc (on the provider
      // call) should have the same content via Y.applyUpdate.
      //
      // We hold a ref to the past doc state so we can compare what
      // the helper APPLIED to the live ydoc.
      replayMock.mockImplementationOnce(() => {
        const d = new Y.Doc()
        d.getText('content').insert(0, 'specific past state')
        return d
      })
      await restoreDocToYjsId({
        doc: docAs('d'), targetYjsId: 5, actorUserId: 1, actorName: 'A', sessionId: 's'
      })
      // The live doc passed to the provider IS the same instance the
      // helper applies the past update to. Inspect its content.
      const liveDoc = first(providerCalls).document
      expect(liveDoc.getText('content').toString()).toBe('specific past state')
    })

    it('destroys the replayed past doc (memory leak guard)', async () => {
      // The past doc is created, encoded, and then destroyed —
      // it's not held anywhere after the function returns. Pin
      // the destroy() call so a future refactor doesn't introduce
      // a long-lived reference.
      const pastDoc = new Y.Doc()
      pastDoc.getText('content').insert(0, 'past')
      const destroySpy = vi.spyOn(pastDoc, 'destroy')
      replayMock.mockResolvedValueOnce(pastDoc)
      await restoreDocToYjsId({
        doc: docAs('d'), targetYjsId: 1, actorUserId: 1, actorName: 'A', sessionId: 's'
      })
      expect(destroySpy).toHaveBeenCalled()
    })
  })

  describe('cleanup paths', () => {
    it('disconnects + destroys the provider on the happy path', async () => {
      await restoreDocToYjsId({
        doc: docAs('d'), targetYjsId: 1, actorUserId: 1, actorName: 'A', sessionId: 's'
      })
      expect(providerInstances).toHaveLength(1)
      expect(first(providerInstances).disconnectCalls).toBe(1)
      expect(first(providerInstances).destroyCalls).toBe(1)
    })

    it('disconnects + destroys the provider on auth failure', async () => {
      // Critical: a failed auth path must NOT leak the provider/WS.
      MockProvider.authFailReason = 'expired token'
      await expect(
        restoreDocToYjsId({
          doc: docAs('d'), targetYjsId: 1, actorUserId: 1, actorName: 'A', sessionId: 's'
        })
      ).rejects.toThrow(/auth failed/)
      expect(providerInstances).toHaveLength(1)
      expect(first(providerInstances).disconnectCalls).toBe(1)
      expect(first(providerInstances).destroyCalls).toBe(1)
    })
  })

  describe('advisory lock (concurrency)', () => {
    it('issues the per-doc advisory lock as the FIRST query of the transaction', async () => {
      // Without this query as the first thing in the tx, two
      // concurrent restores for the same doc could compute inverses
      // against incompatible "live" states and produce a last-write-
      // wins result. Pin the order.
      await restoreDocToYjsId({
        doc: docAs('doc-lock'), targetYjsId: 1, actorUserId: 1, actorName: 'A', sessionId: 's'
      })
      expect(txExecuteCalls.length).toBeGreaterThan(0)
      expect(first(txExecuteCalls).kind).toBe('lock')
    })

    it('uses pg_advisory_xact_lock(hashtext(docId)) so the lock auto-releases on commit/rollback', async () => {
      // Subtle correctness property: an `xact` lock auto-releases
      // when the tx ends (commit or rollback). A plain
      // `pg_advisory_lock` would hold the lock until explicit
      // release — leak risk on error paths. Pin the SQL shape.
      const observedSql: string[] = []
      const origExecute = dbMock.transaction.getMockImplementation()
      dbMock.transaction.mockImplementationOnce(async (fn) => {
        const tx = {
          execute: vi.fn(async (q: { queryChunks?: unknown[] } | unknown) => {
            // drizzle's `sql` template stores chunks; convert to a
            // string by inspecting the queryChunks shape.
            const sqlText = JSON.stringify(q)
            observedSql.push(sqlText)
            // Mirror the canned tx.execute behavior so the helper
            // doesn't choke on the empty result.
            if (observedSql.length === 1) return { rows: [] }
            return { rows: [{ id: 100 }] }
          })
        }
        return await fn(tx)
      })
      await restoreDocToYjsId({
        doc: docAs('doc-shape'), targetYjsId: 1, actorUserId: 1, actorName: 'A', sessionId: 's'
      })
      // The first query's serialized form should mention the
      // xact-scoped advisory lock + hashtext.
      expect(observedSql[0]).toContain('pg_advisory_xact_lock')
      expect(observedSql[0]).toContain('hashtext')
      // Restore the default mock for subsequent tests.
      if (origExecute) dbMock.transaction.mockImplementation(origExecute)
    })
  })

  describe('replay arguments', () => {
    it('replays at the targetYjsId for the right doc', async () => {
      await restoreDocToYjsId({
        doc: docAs('replay-doc'), targetYjsId: 999, actorUserId: 1, actorName: 'A', sessionId: 's'
      })
      expect(replayMock).toHaveBeenCalledWith(expect.objectContaining({ docId: 'replay-doc' }), 999)
    })

    it('refuses a target below the history floor before connecting (never applies an empty doc)', async () => {
      const { YjsHistoryCompactedError } = await import('../../../server/repos/yjsLog')
      replayMock.mockRejectedValueOnce(new YjsHistoryCompactedError('floor-doc', 5, 40))
      await expect(restoreDocToYjsId({
        doc: docAs('floor-doc'), targetYjsId: 5, actorUserId: 1, actorName: 'A', sessionId: 's'
      })).rejects.toMatchObject({ name: 'RestorePointCompactedError', targetYjsId: 5, floorId: 40 })
      expect(providerInstances).toHaveLength(0)
    })
  })
})

// The restore client writes past ymeta values through the WebSocket, where
// the sync server validates them. A past value that fails today's
// validation (old theme schema, corrupted nested Y type) would get the
// whole restore update rejected — so it is skipped instead.
describe('readRestorableMeta', () => {
  it('copies valid restorable keys and skips invalid or corrupted ones', () => {
    const past = new Y.Doc()
    const meta = past.getMap<unknown>('meta')
    meta.set('title', 'Past title')
    meta.set('description', 'd'.repeat(501))
    meta.set('audience', 'casual')
    meta.set('_deleted', true)
    const nested = new Y.Map<unknown>()
    meta.set('theme', nested)
    nested.set('n', new Y.Map<unknown>())

    expect(readRestorableMeta(meta)).toEqual({ title: 'Past title', audience: 'casual' })
  })
})
