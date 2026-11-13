import { evictIdle, getPoolStats, closeAll } from '../utils/mcp/yDocPool'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { SWEEPS } from '../config/sweeps'
import { useLogger } from '../utils/platform/logger'

const log = useLogger('ydoc-pool')

// Idle-eviction sweeper for the YDocPool.
//
// The pool keeps a HocuspocusProvider open per (docId, principalId)
// while refCount > 0, the in-app loop holds for one run; an MCP
// session holds across its tool calls. When refCount hits 0 we stamp
// `lastReleasedAt` and let this sweeper close the entry IDLE_MS after
// the last release.
//
// Process-local: no advisory lock (the pool exists per Nuxt process;
// multi-instance behavior is each process owns its own connections, which is
// the correct shape: Hocuspocus dedupes on its end) and no database, so no
// wait for migrations.
//
// Tick interval is 60s; idle threshold is 5 min. Both are short enough
// that a misbehaving MCP client opening many docs doesn't pin
// connections forever, and long enough that a model issuing several
// `view_document` / `replace_text` calls in succession sees cache hits.

const { idleAfterMs: IDLE_THRESHOLD_MS } = SWEEPS.yDocPool

export default defineSweeper({
  name: 'yDocPoolSweep',
  schedule: SWEEPS.yDocPool,
  lock: false,
  awaitMigrations: false,
  // The pool is empty at boot; the first tick comes after one interval.
  runAtBoot: false,
  run: () => {
    const evicted = evictIdle(IDLE_THRESHOLD_MS)
    if (evicted === 0) return
    const stats = getPoolStats()
    return { evicted, active: stats.size, held: stats.refCountTotal }
  },
  // Force-close every entry on shutdown so in-flight WS connections drain
  // instead of getting killed mid-handshake. Mirrors the pg pool + Valkey
  // client shutdown in `99-shutdown.ts`.
  onClose: () => {
    try {
      closeAll()
    } catch (e) {
      log.warn('closeAll failed during shutdown', { err: e })
    }
  }
})
