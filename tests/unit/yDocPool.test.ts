import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import {
  checkout,
  release,
  evictIdle,
  closeAll,
  getPoolStats,
  _resetForTesting,
  _setBuildEntryForTesting,
  type PoolKey,
  type PoolEntry,
  type PoolCheckoutOpts
} from '../../server/utils/mcp/yDocPool'

// Pool unit tests use the `_setBuildEntryForTesting` seam to avoid
// spawning a real HocuspocusProvider. Each fake entry tracks its own
// "destroyed" flag so we can assert evict-fires-teardown without a
// live WS. The bookkeeping logic (refcount, in-flight dedup, eviction
// math) is what these tests pin — provider integration is covered by
// integration tests against a real sync stack.

interface FakeProvider {
  destroyed: boolean
  disconnected: boolean
  destroy(): void
  disconnect(): void
}

interface FakeEntry extends PoolEntry {
  provider: PoolEntry['provider'] & FakeProvider
}

let fakeBuildCount = 0

function makeFakeEntry(key: PoolKey): FakeEntry {
  const ydoc = new Y.Doc()
  const awareness = new Awareness(ydoc)
  const fakeProvider: FakeProvider = {
    destroyed: false,
    disconnected: false,
    destroy() { this.destroyed = true },
    disconnect() { this.disconnected = true }
  }
  return {
    ydoc,
    ytext: ydoc.getText('content'),
    ymeta: ydoc.getMap<unknown>('meta'),
    awareness,
    provider: fakeProvider as unknown as PoolEntry['provider'] & FakeProvider,
    key,
    refCount: 0,
    lastReleasedAt: 0,
    createdAt: Date.now()
  } as FakeEntry
}

beforeEach(() => {
  _resetForTesting()
  fakeBuildCount = 0
  _setBuildEntryForTesting(async (key: PoolKey, _opts: PoolCheckoutOpts) => {
    fakeBuildCount++
    return makeFakeEntry(key)
  })
})

afterEach(() => {
  _setBuildEntryForTesting(null)
  _resetForTesting()
})

const fakeOpts: PoolCheckoutOpts = {
  jwt: 'fake-jwt',
  awarenessUser: { name: 'test', color: '#888' },
  syncUrl: 'ws://fake'
}

describe('checkout — fresh entry', () => {
  it('builds a new entry on first checkout', async () => {
    const key: PoolKey = { docId: 'doc-1', principalId: 'mcp:s1' }
    const entry = await checkout(key, fakeOpts)
    expect(entry.refCount).toBe(1)
    expect(entry.key).toEqual(key)
    expect(fakeBuildCount).toBe(1)
    expect(getPoolStats().size).toBe(1)
  })

  it('returns the same entry on a second checkout with the same key (cache hit)', async () => {
    const key: PoolKey = { docId: 'doc-1', principalId: 'mcp:s1' }
    const a = await checkout(key, fakeOpts)
    const b = await checkout(key, fakeOpts)
    expect(a).toBe(b)
    expect(a.refCount).toBe(2)
    expect(fakeBuildCount).toBe(1) // build only ran ONCE
  })

  it('builds separate entries for different docIds', async () => {
    await checkout({ docId: 'doc-1', principalId: 'mcp:s1' }, fakeOpts)
    await checkout({ docId: 'doc-2', principalId: 'mcp:s1' }, fakeOpts)
    expect(fakeBuildCount).toBe(2)
    expect(getPoolStats().size).toBe(2)
  })

  it('builds separate entries for the same doc with different principals', async () => {
    // The cornerstone of the "no awareness contention" design — the
    // loop and an MCP session both reading docA each get their own
    // provider.
    await checkout({ docId: 'doc-1', principalId: 'loop:run-1' }, fakeOpts)
    await checkout({ docId: 'doc-1', principalId: 'mcp:s1' }, fakeOpts)
    expect(fakeBuildCount).toBe(2)
    expect(getPoolStats().size).toBe(2)
  })
})

describe('checkout — concurrent in-flight dedup', () => {
  it('two concurrent checkouts of the same key share one build', async () => {
    // Slow the builder so both calls land in the in-flight map at once.
    let resolveBuilder!: (entry: PoolEntry) => void
    _setBuildEntryForTesting(async (key: PoolKey) => {
      fakeBuildCount++
      return new Promise<PoolEntry>((res) => {
        resolveBuilder = res
        // Resolve after the second checkout has registered.
        setImmediate(() => res(makeFakeEntry(key)))
      })
    })

    const key: PoolKey = { docId: 'doc-1', principalId: 'mcp:s1' }
    const [a, b] = await Promise.all([checkout(key, fakeOpts), checkout(key, fakeOpts)])
    expect(a).toBe(b)
    expect(a.refCount).toBe(2)
    expect(fakeBuildCount).toBe(1)
    expect(getPoolStats().inflightCount).toBe(0)
    void resolveBuilder // keep TS happy about the unused capture
  })

  it('a build failure unwinds the in-flight slot so retries can proceed', async () => {
    let firstCallFailed = false
    _setBuildEntryForTesting(async (key) => {
      if (!firstCallFailed) {
        firstCallFailed = true
        throw new Error('boom')
      }
      return makeFakeEntry(key)
    })

    const key: PoolKey = { docId: 'doc-1', principalId: 'mcp:s1' }
    await expect(checkout(key, fakeOpts)).rejects.toThrow('boom')
    expect(getPoolStats().inflightCount).toBe(0)
    expect(getPoolStats().size).toBe(0)

    // Retry succeeds — the in-flight slot was cleared on failure.
    const entry = await checkout(key, fakeOpts)
    expect(entry.refCount).toBe(1)
  })
})

describe('release — refCount bookkeeping', () => {
  it('decrements refCount on release', async () => {
    const key: PoolKey = { docId: 'doc-1', principalId: 'mcp:s1' }
    await checkout(key, fakeOpts)
    await checkout(key, fakeOpts)
    release(key)
    expect(getPoolStats().refCountTotal).toBe(1)
    release(key)
    expect(getPoolStats().refCountTotal).toBe(0)
  })

  it('stamps lastReleasedAt only when refCount hits 0', async () => {
    const key: PoolKey = { docId: 'doc-1', principalId: 'mcp:s1' }
    const a = await checkout(key, fakeOpts)
    await checkout(key, fakeOpts)
    expect(a.lastReleasedAt).toBe(0)
    release(key)
    expect(a.lastReleasedAt).toBe(0) // still in use
    release(key)
    expect(a.lastReleasedAt).toBeGreaterThan(0)
  })

  it('release on an unknown key is a no-op (idempotent)', () => {
    expect(() => release({ docId: 'nope', principalId: 'mcp:nope' })).not.toThrow()
  })

  it('over-release does not push refCount negative', async () => {
    const key: PoolKey = { docId: 'doc-1', principalId: 'mcp:s1' }
    await checkout(key, fakeOpts)
    release(key)
    release(key) // bonus release
    release(key) // another bonus
    expect(getPoolStats().refCountTotal).toBe(0)
  })
})

describe('evictIdle', () => {
  it('evicts entries whose refCount=0 AND idle > maxIdleMs', async () => {
    const key1: PoolKey = { docId: 'doc-1', principalId: 'mcp:s1' }
    const key2: PoolKey = { docId: 'doc-2', principalId: 'mcp:s1' }
    const e1 = await checkout(key1, fakeOpts) as FakeEntry
    const e2 = await checkout(key2, fakeOpts) as FakeEntry
    release(key1)
    release(key2)

    // Backdate one entry to "long ago"; leave the other "recent".
    e1.lastReleasedAt = Date.now() - 60_000
    e2.lastReleasedAt = Date.now() - 1_000

    const evicted = evictIdle(30_000) // 30s threshold
    expect(evicted).toBe(1)
    expect(getPoolStats().size).toBe(1)
    expect((e1.provider as unknown as FakeProvider).destroyed).toBe(true)
    expect((e2.provider as unknown as FakeProvider).destroyed).toBe(false)
  })

  it('never evicts entries with refCount > 0', async () => {
    const key: PoolKey = { docId: 'doc-1', principalId: 'mcp:s1' }
    const e = await checkout(key, fakeOpts) as FakeEntry
    // Pretend it's been "idle" for ages (it hasn't, refCount=1).
    e.lastReleasedAt = Date.now() - 60_000
    const evicted = evictIdle(30_000)
    expect(evicted).toBe(0)
    expect(getPoolStats().size).toBe(1)
  })

  it('returns 0 and changes nothing when nothing is idle', async () => {
    const key: PoolKey = { docId: 'doc-1', principalId: 'mcp:s1' }
    await checkout(key, fakeOpts)
    release(key)
    const evicted = evictIdle(60 * 60_000)
    expect(evicted).toBe(0)
    expect(getPoolStats().size).toBe(1)
  })

  it('handles many entries without missing any eligible ones', async () => {
    // 20 entries, all idle, all past threshold — verify the iteration
    // doesn't get confused by mid-loop deletions.
    const keys: PoolKey[] = []
    for (let i = 0; i < 20; i++) {
      const k: PoolKey = { docId: `doc-${i}`, principalId: 'mcp:s1' }
      keys.push(k)
      const e = await checkout(k, fakeOpts) as FakeEntry
      release(k)
      e.lastReleasedAt = Date.now() - 60_000
    }
    const evicted = evictIdle(30_000)
    expect(evicted).toBe(20)
    expect(getPoolStats().size).toBe(0)
  })
})

describe('closeAll — graceful shutdown', () => {
  it('closes every entry regardless of refCount', async () => {
    const k1: PoolKey = { docId: 'd1', principalId: 'mcp:s1' }
    const k2: PoolKey = { docId: 'd2', principalId: 'mcp:s2' }
    const e1 = await checkout(k1, fakeOpts) as FakeEntry
    const e2 = await checkout(k2, fakeOpts) as FakeEntry
    closeAll()
    expect(getPoolStats().size).toBe(0)
    expect((e1.provider as unknown as FakeProvider).destroyed).toBe(true)
    expect((e2.provider as unknown as FakeProvider).destroyed).toBe(true)
  })
})

describe('getPoolStats — observability', () => {
  it('reports size, refCountTotal, inflight, oldestIdleMs', async () => {
    expect(getPoolStats()).toEqual({ size: 0, refCountTotal: 0, inflightCount: 0, oldestIdleMs: null })

    const k1: PoolKey = { docId: 'd1', principalId: 'mcp:s1' }
    const k2: PoolKey = { docId: 'd2', principalId: 'mcp:s1' }
    const e1 = await checkout(k1, fakeOpts) as FakeEntry
    await checkout(k2, fakeOpts)
    release(k1)
    e1.lastReleasedAt = Date.now() - 5_000

    const stats = getPoolStats()
    expect(stats.size).toBe(2)
    expect(stats.refCountTotal).toBe(1) // k2 still held
    expect(stats.oldestIdleMs).toBeGreaterThanOrEqual(5_000)
  })
})
