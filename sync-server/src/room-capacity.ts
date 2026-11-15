// Room capacity: how many documents this sync server keeps in memory.
//
// Three parts:
//
//   - Grace rooms (SYNC_UNLOAD_GRACE_MS). Hocuspocus unloads a document
//     the moment its last connection closes (after storing any pending
//     edits), so a reload or a quick switch between two documents loaded
//     it from Postgres every time. `beforeUnloadDocument` calls `hold()`:
//     the first unload attempt after the last connection left is vetoed
//     and retried after the grace period. Persistence is not delayed:
//     Hocuspocus runs the pending store before it tries to unload, and a
//     document only reaches `beforeUnloadDocument` once nothing is left
//     to store. A connection that arrives in time finds the document in
//     memory and cancels the grace (`cancel()`).
//
//   - Room cap (SYNC_MAX_ROOMS, enforced by the rate limiter): a new
//     document beyond it is refused as busy.
//
//   - Memory guard (SYNC_MEMORY_GUARD_PERCENT of SYNC_MEMORY_LIMIT_BYTES,
//     by default the container's cgroup limit): a new document is refused
//     as busy while the process's resident memory is above it.
//
// Before either refuses, `makeRoom()` unloads grace rooms, oldest first:
// a document nobody has open is the cheapest thing to give up.
//
// Multi-instance: a grace room is only kept by this instance. A client
// pinned to another instance that edits the document in that window is
// not seen here; the same holds while two instances have it open at
// once (sticky sessions pin clients, not documents).

import { readFileSync } from 'node:fs'
import { syncEnv } from './env'
import { useLogger } from './logger'

const log = useLogger('room-capacity')

/** Hocuspocus' unload veto: thrown from beforeUnloadDocument. Its empty
 *  message keeps Hocuspocus from logging every hold as an error. */
export class GraceHold extends Error {
  constructor() {
    super('')
    this.name = 'GraceHold'
  }
}

interface CapacityDocument {
  getConnectionsCount: () => number
}

/** The parts of the Hocuspocus instance this module touches. */
export interface CapacityInstance {
  documents: Map<string, CapacityDocument>
  loadingDocuments?: Map<string, unknown>
  // Method syntax: Hocuspocus' own takes its richer `Document`.
  unloadDocument(doc: CapacityDocument): Promise<unknown>
}

interface Hold {
  timer: ReturnType<typeof setTimeout> | null
  /** The grace is over: the next unload attempt goes through. */
  released: boolean
}

export interface GraceRoomsOptions {
  graceMs: number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void
}

export function createGraceRooms(opts: GraceRoomsOptions) {
  const setTimer = opts.setTimer ?? ((fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  })
  const clearTimer = opts.clearTimer ?? (t => clearTimeout(t))
  // Insertion order = age: the first entry is the oldest hold.
  const holds = new Map<string, Hold>()
  let stopped = false

  function drop(name: string): void {
    const h = holds.get(name)
    if (!h) return
    if (h.timer) clearTimer(h.timer)
    holds.delete(name)
  }

  async function unload(instance: CapacityInstance, name: string): Promise<boolean> {
    const doc = instance.documents.get(name)
    if (!doc || doc.getConnectionsCount() > 0) {
      drop(name)
      return false
    }
    const h = holds.get(name)
    if (h) {
      if (h.timer) clearTimer(h.timer)
      h.timer = null
      h.released = true
    }
    await instance.unloadDocument(doc)
    // Still loaded (a store or a connection got in between, or the
    // unsaved-edits veto): a fresh hold starts with its next unload.
    drop(name)
    return !instance.documents.has(name)
  }

  return {
    /**
     * Called from beforeUnloadDocument. Throws GraceHold to keep the
     * document for the grace period; returns to let the unload proceed.
     */
    hold(instance: CapacityInstance, name: string): void {
      if (stopped || opts.graceMs <= 0) return
      const existing = holds.get(name)
      if (existing?.released) {
        holds.delete(name)
        return
      }
      if (existing) throw new GraceHold()
      const h: Hold = { timer: null, released: false }
      h.timer = setTimer(() => {
        h.timer = null
        unload(instance, name).catch((e: unknown) => {
          log.warn('grace unload failed', { docId: name, err: e })
        })
      }, opts.graceMs)
      holds.set(name, h)
      throw new GraceHold()
    },

    /** A connection reached the document: it is in use again. */
    cancel(name: string): void {
      drop(name)
    },

    /** The document left memory (any path). */
    forget(name: string): void {
      drop(name)
    },

    /** Unload the oldest grace room. False when there is none to give up. */
    async evictOldest(instance: CapacityInstance, except?: string): Promise<boolean> {
      for (const name of [...holds.keys()]) {
        if (name === except) continue
        if (await unload(instance, name)) return true
      }
      return false
    },

    /** The next unload of this document skips the grace (deleted documents). */
    skip(name: string): void {
      const h = holds.get(name)
      if (h?.timer) clearTimer(h.timer)
      holds.set(name, { timer: null, released: true })
    },

    /** Shutdown: no new holds; unload every held document. */
    async releaseAll(instance: CapacityInstance): Promise<void> {
      stopped = true
      for (const name of [...holds.keys()]) await unload(instance, name)
    },

    size(): number {
      return holds.size
    },

    has(name: string): boolean {
      return holds.has(name)
    }
  }
}

export type GraceRooms = ReturnType<typeof createGraceRooms>

export const graceRooms = createGraceRooms({ graceMs: syncEnv().sync.unloadGraceMs })

// Memory guard

const CGROUP_V2_MEMORY_MAX = '/sys/fs/cgroup/memory.max'

/** Reads only the two cgroup files below. */
function readCgroupFile(path: string): string {
  return path === CGROUP_V2_MEMORY_MAX
    ? readFileSync('/sys/fs/cgroup/memory.max', 'utf8')
    : readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8')
}

/** The container's memory limit from the cgroup (v2, then v1); null when unlimited or unknown. */
export function cgroupMemoryLimit(read: (path: string) => string = readCgroupFile): number | null {
  for (const path of [CGROUP_V2_MEMORY_MAX, '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    let raw: string
    try {
      raw = read(path).trim()
    } catch {
      continue
    }
    if (!/^\d+$/.test(raw)) return null // "max": no limit
    const n = Number(raw)
    // cgroup v1 reports "no limit" as a number near 2^63.
    if (!Number.isSafeInteger(n) || n <= 0 || n >= 2 ** 60) return null
    return n
  }
  return null
}

export interface MemoryGuardOptions {
  /** 0 turns the guard off. */
  percent: number
  /** Null turns the guard off. */
  limitBytes: number | null
  rss?: () => number
}

export function createMemoryGuard(opts: MemoryGuardOptions) {
  const rss = opts.rss ?? (() => process.memoryUsage.rss())
  const threshold = opts.percent > 0 && opts.limitBytes ? Math.floor(opts.limitBytes * opts.percent / 100) : null
  return {
    threshold,
    /** The process uses more memory than a new document may take. */
    underPressure(): boolean {
      return threshold !== null && rss() >= threshold
    }
  }
}

export type MemoryGuard = ReturnType<typeof createMemoryGuard>

/** The document is in memory here (or being loaded): joining it adds no room. */
function isOpen(instance: CapacityInstance, name: string | undefined): boolean {
  if (!name) return false
  return instance.documents.has(name) || instance.loadingDocuments?.has(name) === true
}

/**
 * Before a connection that would open a new document: give up grace rooms
 * while the room cap or the memory guard would refuse it. The refusal
 * itself stays in the rate limiter.
 */
export async function makeRoom(
  instance: CapacityInstance,
  documentName: string | undefined,
  graceRooms: GraceRooms,
  limits: { maxRooms: number, memory: MemoryGuard }
): Promise<void> {
  if (graceRooms.size() === 0 || isOpen(instance, documentName)) return
  while (instance.documents.size >= limits.maxRooms) {
    if (!await graceRooms.evictOldest(instance, documentName)) return
  }
  if (limits.memory.underPressure()) {
    // Resident memory falls only after a garbage collection, so give up
    // every grace room at once instead of re-measuring after each.
    while (await graceRooms.evictOldest(instance, documentName)) { /* next */ }
  }
}
