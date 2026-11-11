// Unit tests for the sync-server's Valkey-backed per-doc state helpers (sync-server/src/sync-state.ts).
// Imported cross-package from the root tests/unit suite, like compaction.test.ts, because sync-server's own
// src/__tests__ dir is NOT wired into the CI vitest projects; a test left there never runs in the pipeline.
// Mocks the singleton ioredis client via the `_setValkeyClientForTests` seam so the tests never touch a live Valkey.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getLastEditor,
  setLastEditor,
  getPrevText,
  setPrevText,
  getPrevMeta,
  setPrevMeta,
  dropDocState
} from '../../../sync-server/src/sync-state'
import { _setValkeyClientForTests } from '../../../sync-server/src/valkey'

// Minimal in-memory fake of the ioredis surface we touch. Just enough to
// verify reads/writes round-trip and to inject error throws.
function makeFake(opts: { throwOnGet?: boolean, throwOnSet?: boolean } = {}) {
  const store = new Map<string, string>()
  const calls: { op: string, key: string, value?: string, ttl?: number }[] = []
  const fake = {
    async get(key: string): Promise<string | null> {
      calls.push({ op: 'get', key })
      if (opts.throwOnGet) throw new Error('valkey-down')
      return store.get(key) ?? null
    },
    async set(key: string, value: string, _ex?: 'EX', ttl?: number): Promise<'OK'> {
      calls.push({ op: 'set', key, value, ttl })
      if (opts.throwOnSet) throw new Error('valkey-down')
      store.set(key, value)
      return 'OK'
    },
    async del(...keys: string[]): Promise<number> {
      let n = 0
      for (const k of keys) {
        calls.push({ op: 'del', key: k })
        if (store.delete(k)) n++
      }
      return n
    },
    on() { /* noop — sync-state never subscribes */ }
  }
  // The valkey singleton type is `Redis`; the fake satisfies the
  // narrow surface our code uses (`get`, `set`, `del`). Cast at the
  // injection point only.
  return { fake: fake as unknown as Parameters<typeof _setValkeyClientForTests>[0], store, calls }
}

describe('sync-state — Valkey-backed per-doc state', () => {
  beforeEach(() => {
    _setValkeyClientForTests(null)
    vi.restoreAllMocks()
  })

  describe('last-editor', () => {
    it('round-trips a value through Valkey with 24h TTL', async () => {
      const { fake, calls } = makeFake()
      _setValkeyClientForTests(fake)

      await setLastEditor('doc1', { userName: 'Alice', userId: '42', at: 1000 })
      const result = await getLastEditor('doc1')

      expect(result.cause).toBe('hit')
      expect(result.value).toEqual({ userName: 'Alice', userId: '42', at: 1000 })
      const setCall = calls.find(c => c.op === 'set')
      expect(setCall?.ttl).toBe(86400)
      expect(setCall?.key).toBe('sync:last-editor:doc1')
    })

    it('returns cause=miss when key is absent (cold doc / restart)', async () => {
      const { fake } = makeFake()
      _setValkeyClientForTests(fake)

      const result = await getLastEditor('unknown-doc')

      expect(result.cause).toBe('miss')
      expect(result.value).toBeNull()
      expect(result.error).toBeUndefined()
    })

    it('returns cause=error when Valkey throws (Valkey down)', async () => {
      const { fake } = makeFake({ throwOnGet: true })
      _setValkeyClientForTests(fake)

      const result = await getLastEditor('doc1')

      expect(result.cause).toBe('error')
      expect(result.value).toBeNull()
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error?.message).toBe('valkey-down')
    })

    it('treats malformed JSON as a miss (not a crash)', async () => {
      const { fake, store } = makeFake()
      _setValkeyClientForTests(fake)
      // Hand-poison the store with invalid JSON.
      store.set('sync:last-editor:doc1', '{not-valid')

      const result = await getLastEditor('doc1')

      expect(result.cause).toBe('miss')
      expect(result.value).toBeNull()
    })
  })

  describe('prev-text', () => {
    it('round-trips a value with 24h TTL', async () => {
      const { fake, calls } = makeFake()
      _setValkeyClientForTests(fake)

      await setPrevText('doc1', '# hello\nworld')
      const result = await getPrevText('doc1')

      expect(result.cause).toBe('hit')
      expect(result.value).toBe('# hello\nworld')
      const setCall = calls.find(c => c.op === 'set' && c.key === 'sync:prev-text:doc1')
      expect(setCall?.ttl).toBe(86400)
    })

    it('returns cause=miss on absent key', async () => {
      const { fake } = makeFake()
      _setValkeyClientForTests(fake)

      const result = await getPrevText('unknown')

      expect(result.cause).toBe('miss')
      expect(result.value).toBeNull()
    })

    it('returns cause=error when Valkey throws', async () => {
      const { fake } = makeFake({ throwOnGet: true })
      _setValkeyClientForTests(fake)

      const result = await getPrevText('doc1')

      expect(result.cause).toBe('error')
      expect(result.error?.message).toBe('valkey-down')
    })
  })

  describe('prev-meta', () => {
    it('round-trips title + themeHash', async () => {
      const { fake } = makeFake()
      _setValkeyClientForTests(fake)

      await setPrevMeta('doc1', { title: 'Hello', themeHash: '{"font":"Inter"}' })
      const result = await getPrevMeta('doc1')

      expect(result.cause).toBe('hit')
      expect(result.value).toEqual({ title: 'Hello', themeHash: '{"font":"Inter"}' })
    })

    it('returns cause=miss on absent key', async () => {
      const { fake } = makeFake()
      _setValkeyClientForTests(fake)

      const result = await getPrevMeta('unknown')

      expect(result.cause).toBe('miss')
    })

    it('returns cause=error on Valkey throw', async () => {
      const { fake } = makeFake({ throwOnGet: true })
      _setValkeyClientForTests(fake)

      const result = await getPrevMeta('doc1')

      expect(result.cause).toBe('error')
    })

    it('treats malformed JSON as miss', async () => {
      const { fake, store } = makeFake()
      _setValkeyClientForTests(fake)
      store.set('sync:prev-meta:doc1', '{nope')

      const result = await getPrevMeta('doc1')

      expect(result.cause).toBe('miss')
    })
  })

  describe('dropDocState', () => {
    it('deletes all three keys for a doc', async () => {
      const { fake, store, calls } = makeFake()
      _setValkeyClientForTests(fake)

      store.set('sync:last-editor:doc1', '{"userName":"a","userId":"1","at":0}')
      store.set('sync:prev-text:doc1', 'x')
      store.set('sync:prev-meta:doc1', '{"title":"a","themeHash":null}')

      await dropDocState('doc1')

      expect(store.size).toBe(0)
      const delKeys = calls.filter(c => c.op === 'del').map(c => c.key).sort((a, b) => a.localeCompare(b))
      expect(delKeys).toEqual([
        'sync:last-editor:doc1',
        'sync:prev-meta:doc1',
        'sync:prev-text:doc1'
      ])
    })

    it('does not throw if Valkey rejects the del (best-effort cleanup)', async () => {
      const fake = {
        async get() { return null },
        async set() { return 'OK' as const },
        async del() { throw new Error('valkey-down') },
        on() {}
      }
      _setValkeyClientForTests(fake as unknown as Parameters<typeof _setValkeyClientForTests>[0])

      // Should not throw.
      await expect(dropDocState('doc1')).resolves.toBeUndefined()
    })
  })
})
