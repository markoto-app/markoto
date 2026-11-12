import type { PoolLike, YjsStore } from './yjs-store'
import { DAY_MS } from '../../shared/config/units'
import type { Logger } from './logger'

// Background maintenance of the `yjs_updates` log (SQL in yjs-store.ts).
//
// 1. Snapshots. The persistence layer counts updates per live document and
//    queues a document once it has more than COMPACT_THRESHOLD updates since
//    its newest snapshot (at load, or while it stays open). Each sweep writes
//    a snapshot for up to COMPACT_MAX_DOCS_PER_RUN queued documents. A
//    snapshot deletes nothing: every id stays replayable, loads start from
//    the snapshot.
// 2. Pruning, only with COMPACT_RETAIN_HISTORY_DAYS > 0. For a document with
//    a snapshot older than the retention window, every row below the newest
//    such snapshot is deleted. Ids from that snapshot on stay replayable; any
//    activity row written within the window only names ids at or above it
//    (an id is the newest row at the time it was recorded, and the snapshot
//    already existed then), so the plan's history window keeps working as
//    long as the retention is at least as long.
//
// Both steps take the per-document write lock (yjs-store.ts), so they are
// safe next to live stores and on several instances at once; the sweep-wide
// advisory lock below only keeps instances from scanning in parallel.

const SWEEP_LOCK_NAME = 'yjs-compaction-sweep'

export interface CompactionDeps {
  store: YjsStore
  pool: PoolLike
  log: Logger
  capture: (e: unknown, tags: Record<string, string>) => void
  intervalMs: number
  maxDocsPerRun: number
  retainHistoryDays: number
  /** Runs at the end of every sweep (the persistence counters are logged there). */
  afterSweep?: () => void
  now?: () => Date
}

export interface SweepResult {
  snapshots: number
  pruned: number
  rowsDeleted: number
  skipped: boolean
}

export function createCompactionSweeper(deps: CompactionDeps) {
  const queue = new Set<string>()
  let timer: ReturnType<typeof setInterval> | null = null
  let running: Promise<SweepResult> | null = null

  async function sweepUnderLock(): Promise<Omit<SweepResult, 'skipped'>> {
    const result = { snapshots: 0, pruned: 0, rowsDeleted: 0 }
    const batch = [...queue].slice(0, deps.maxDocsPerRun)
    for (const docId of batch) {
      queue.delete(docId)
      try {
        const snap = await deps.store.writeSnapshot(docId)
        if (snap) {
          result.snapshots++
          deps.log.debug('wrote snapshot', { docId, id: snap.id, updatesMerged: snap.updatesMerged, bytes: snap.bytes })
        }
      } catch (e) {
        deps.log.error('snapshot failed', { docId, err: e })
        deps.capture(e, { component: 'compaction', event: 'snapshot_failed', docId })
      }
    }

    if (deps.retainHistoryDays > 0) {
      const cutoff = new Date((deps.now?.() ?? new Date()).getTime() - deps.retainHistoryDays * DAY_MS)
      const candidates = await deps.store.pruneCandidates(cutoff, deps.maxDocsPerRun)
      for (const docId of candidates) {
        try {
          const deleted = await deps.store.prune(docId, cutoff)
          if (deleted > 0) {
            result.pruned++
            result.rowsDeleted += deleted
          }
        } catch (e) {
          deps.log.error('prune failed', { docId, err: e })
          deps.capture(e, { component: 'compaction', event: 'prune_failed', docId })
        }
      }
    }
    return result
  }

  async function sweep(): Promise<SweepResult> {
    const lockClient = await deps.pool.connect()
    try {
      const got = await lockClient.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [SWEEP_LOCK_NAME]
      )
      if (!got.rows[0]?.locked) return { snapshots: 0, pruned: 0, rowsDeleted: 0, skipped: true }
      try {
        const result = await sweepUnderLock()
        if (result.snapshots > 0 || result.pruned > 0) deps.log.info('compaction sweep', result)
        return { ...result, skipped: false }
      } finally {
        await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [SWEEP_LOCK_NAME])
          .catch(() => { /* the session ending releases it anyway */ })
      }
    } finally {
      lockClient.release()
    }
  }

  /** One sweep now (tests, and the interval below). Never runs two at once. */
  function runOnce(): Promise<SweepResult> {
    if (running) return running
    running = sweep().finally(() => {
      running = null
    })
    return running
  }

  return {
    /** Queue a document for a snapshot at the next sweep. */
    enqueue(docId: string): void {
      queue.add(docId)
    },

    queued(): string[] {
      return [...queue]
    },

    runOnce,

    start(): void {
      if (deps.intervalMs <= 0) {
        deps.log.info('compaction disabled (COMPACT_INTERVAL_MS <= 0)')
        return
      }
      if (timer) return
      timer = setInterval(() => {
        runOnce()
          .catch((e: unknown) => {
            deps.log.error('compaction sweep failed', { err: e })
            deps.capture(e, { component: 'compaction', event: 'sweep_failed' })
          })
          .finally(() => deps.afterSweep?.())
      }, deps.intervalMs)
      timer.unref?.()
      deps.log.info('compaction started', {
        everySeconds: Math.round(deps.intervalMs / 1000),
        retainHistoryDays: deps.retainHistoryDays
      })
    },

    async stop(): Promise<void> {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      await running?.catch(() => { /* reported by the interval */ })
    }
  }
}
