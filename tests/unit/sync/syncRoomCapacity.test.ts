import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  cgroupMemoryLimit,
  createGraceRooms,
  createMemoryGuard,
  GraceHold,
  makeRoom,
  type CapacityInstance
} from '../../../sync-server/src/room-capacity'
import { createRateLimiter, SyncBusyError } from '../../../sync-server/src/rate-limiter'
import { captureLogs } from '../../helpers/logs'

captureLogs()

// A Hocuspocus instance reduced to what room-capacity touches. Its
// `unloadDocument` follows Hocuspocus 3.4.4: skip while connected, ask
// beforeUnloadDocument (a throw vetoes), then drop the document.
function fakeInstance(graceRooms: ReturnType<typeof createGraceRooms>) {
  const connections = new Map<string, number>()
  const documents = new Map<string, { getConnectionsCount: () => number }>()
  const unloaded: string[] = []
  const instance: CapacityInstance = {
    documents,
    loadingDocuments: new Map(),
    async unloadDocument(doc) {
      const name = [...documents.entries()].find(([, d]) => d === doc)?.[0]
      if (!name || doc.getConnectionsCount() > 0) return
      try {
        graceRooms.hold(instance, name)
      } catch (e) {
        if (e instanceof GraceHold) return
        throw e
      }
      documents.delete(name)
      unloaded.push(name)
      graceRooms.forget(name)
    }
  }
  return {
    instance,
    unloaded,
    open(name: string, conns = 0) {
      connections.set(name, conns)
      documents.set(name, { getConnectionsCount: () => connections.get(name) ?? 0 })
    },
    setConnections(name: string, n: number) {
      connections.set(name, n)
    },
    lastClosed(name: string) {
      connections.set(name, 0)
      const doc = documents.get(name)
      if (doc) return instance.unloadDocument(doc)
      return Promise.resolve()
    }
  }
}

describe('grace rooms', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a document for the grace period after its last connection, then unloads it', async () => {
    const grace = createGraceRooms({ graceMs: 30_000 })
    const h = fakeInstance(grace)
    h.open('doc-a')
    await h.lastClosed('doc-a')
    expect(h.instance.documents.has('doc-a')).toBe(true)
    expect(grace.has('doc-a')).toBe(true)

    await vi.advanceTimersByTimeAsync(29_999)
    expect(h.instance.documents.has('doc-a')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.unloaded).toEqual(['doc-a'])
    expect(grace.size()).toBe(0)
  })

  it('unloads at once with a grace of 0', async () => {
    const grace = createGraceRooms({ graceMs: 0 })
    const h = fakeInstance(grace)
    h.open('doc-a')
    await h.lastClosed('doc-a')
    expect(h.unloaded).toEqual(['doc-a'])
  })

  it('a connection in the grace period keeps the document, and its next close starts a fresh grace', async () => {
    const grace = createGraceRooms({ graceMs: 30_000 })
    const h = fakeInstance(grace)
    h.open('doc-a')
    await h.lastClosed('doc-a')
    await vi.advanceTimersByTimeAsync(10_000)
    h.setConnections('doc-a', 1)
    grace.cancel('doc-a')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.instance.documents.has('doc-a')).toBe(true)

    await h.lastClosed('doc-a')
    await vi.advanceTimersByTimeAsync(29_000)
    expect(h.instance.documents.has('doc-a')).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.unloaded).toEqual(['doc-a'])
  })

  it('a grace timer that finds a connection does not unload and forgets the hold', async () => {
    const grace = createGraceRooms({ graceMs: 30_000 })
    const h = fakeInstance(grace)
    h.open('doc-a')
    await h.lastClosed('doc-a')
    h.setConnections('doc-a', 1) // joined, `connected` not reached yet
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.instance.documents.has('doc-a')).toBe(true)
    expect(grace.has('doc-a')).toBe(false)
  })

  it('evictOldest unloads the oldest grace room first and skips the one being opened', async () => {
    const grace = createGraceRooms({ graceMs: 30_000 })
    const h = fakeInstance(grace)
    for (const name of ['old', 'mid', 'new']) {
      h.open(name)
      await h.lastClosed(name)
    }
    expect(await grace.evictOldest(h.instance, 'old')).toBe(true)
    expect(h.unloaded).toEqual(['mid'])
    expect(await grace.evictOldest(h.instance)).toBe(true)
    expect(h.unloaded).toEqual(['mid', 'old'])
  })

  it('skip() makes the next unload immediate (deleted documents)', async () => {
    const grace = createGraceRooms({ graceMs: 30_000 })
    const h = fakeInstance(grace)
    h.open('doc-a')
    await h.lastClosed('doc-a')
    grace.skip('doc-a')
    await h.lastClosed('doc-a')
    expect(h.unloaded).toEqual(['doc-a'])
  })

  it('releaseAll unloads every grace room and stops holding new ones (shutdown)', async () => {
    const grace = createGraceRooms({ graceMs: 30_000 })
    const h = fakeInstance(grace)
    h.open('a')
    h.open('b')
    await h.lastClosed('a')
    await grace.releaseAll(h.instance)
    expect(h.unloaded).toEqual(['a'])
    await h.lastClosed('b')
    expect(h.unloaded).toEqual(['a', 'b'])
  })
})

describe('makeRoom', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const noPressure = createMemoryGuard({ percent: 0, limitBytes: null })

  it('gives up grace rooms until a new document fits under the room cap', async () => {
    const grace = createGraceRooms({ graceMs: 30_000 })
    const h = fakeInstance(grace)
    h.open('busy', 1)
    for (const name of ['g1', 'g2']) {
      h.open(name)
      await h.lastClosed(name)
    }
    await makeRoom(h.instance, 'new-doc', grace, { maxRooms: 2, memory: noPressure })
    expect(h.unloaded).toEqual(['g1', 'g2'])
    expect(h.instance.documents.size).toBe(1)
  })

  it('leaves grace rooms alone for a document that is already open', async () => {
    const grace = createGraceRooms({ graceMs: 30_000 })
    const h = fakeInstance(grace)
    h.open('g1')
    await h.lastClosed('g1')
    await makeRoom(h.instance, 'g1', grace, { maxRooms: 1, memory: noPressure })
    expect(h.unloaded).toEqual([])
  })

  it('gives up every grace room under memory pressure', async () => {
    const grace = createGraceRooms({ graceMs: 30_000 })
    const h = fakeInstance(grace)
    for (const name of ['g1', 'g2', 'g3']) {
      h.open(name)
      await h.lastClosed(name)
    }
    const pressured = createMemoryGuard({ percent: 85, limitBytes: 1000, rss: () => 900 })
    await makeRoom(h.instance, 'new-doc', grace, { maxRooms: 100, memory: pressured })
    expect(h.unloaded).toEqual(['g1', 'g2', 'g3'])
  })
})

describe('memory guard', () => {
  it('is under pressure at or above the share of the limit', () => {
    let rss = 849
    const guard = createMemoryGuard({ percent: 85, limitBytes: 1000, rss: () => rss })
    expect(guard.threshold).toBe(850)
    expect(guard.underPressure()).toBe(false)
    rss = 850
    expect(guard.underPressure()).toBe(true)
  })

  it('is off with percent 0 or without a limit', () => {
    expect(createMemoryGuard({ percent: 0, limitBytes: 1000, rss: () => 10_000 }).underPressure()).toBe(false)
    expect(createMemoryGuard({ percent: 85, limitBytes: null, rss: () => 10_000 }).underPressure()).toBe(false)
  })

  it('reads the cgroup v2 limit, then v1, and treats "max" or a huge v1 value as none', () => {
    const files = (map: Record<string, string>) => (p: string) => {
      const v = map[p]
      if (v === undefined) throw new Error('ENOENT')
      return v
    }
    expect(cgroupMemoryLimit(files({ '/sys/fs/cgroup/memory.max': '1073741824\n' }))).toBe(1073741824)
    expect(cgroupMemoryLimit(files({ '/sys/fs/cgroup/memory.max': 'max\n' }))).toBeNull()
    expect(cgroupMemoryLimit(files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '536870912' }))).toBe(536870912)
    expect(cgroupMemoryLimit(files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712' }))).toBeNull()
    expect(cgroupMemoryLimit(files({}))).toBeNull()
  })

  it('makes the rate limiter refuse a new document as busy, but not a join to an open one', () => {
    const limiter = createRateLimiter({ maxActiveRooms: 100, memoryPressure: () => true })
    const instance = {
      documents: { size: 1, has: (n: string) => n === 'open-doc' },
      loadingDocuments: { has: () => false }
    }
    const data = (documentName: string) => ({
      request: { headers: { 'x-forwarded-for': '1.2.3.4' } },
      socketId: `s-${documentName}`,
      documentName,
      instance
    })
    expect(() => limiter.onConnect(data('new-doc'))).toThrow(SyncBusyError)
    expect(() => limiter.onConnect(data('open-doc'))).not.toThrow()
  })
})
