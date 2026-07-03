import * as Sentry from '@sentry/nuxt'
import { evictIdle, getPoolStats, closeAll } from '../utils/yDocPool'

// Idle-eviction sweeper for the YDocPool.
//
// The pool keeps a HocuspocusProvider open per (docId, principalId)
// while refCount > 0 — the in-app loop holds for one run; an MCP
// session holds across its tool calls. When refCount hits 0 we stamp
// `lastReleasedAt` and let this sweeper close the entry IDLE_MS after
// the last release.
//
// Process-local — no advisory lock needed (the pool exists per Nuxt
// process; multi-instance behavior is each process owns its own
// connections, which is the correct shape — Hocuspocus dedupes on
// its end).
//
// Tick interval is 60s; idle threshold is 5 min. Both are short enough
// that a misbehaving MCP client opening many docs doesn't pin
// connections forever, and long enough that a model issuing several
// `view_document` / `replace_text` calls in succession sees cache hits.

const TICK_INTERVAL_MS = 60 * 1000
const IDLE_THRESHOLD_MS = 5 * 60 * 1000

export default defineNitroPlugin((nitroApp) => {
  let running = false

  function tick(): void {
    if (running) return
    running = true
    try {
      const evicted = evictIdle(IDLE_THRESHOLD_MS)
      if (evicted > 0) {
        const stats = getPoolStats()
        // Visible in dev for debugging idle-eviction churn; in prod the
        // log lands wherever Nitro's stdout goes (Sentry breadcrumbs in
        // managed deployments). No Sentry capture — eviction is the
        // happy path, not an event.
        console.log(`[yDocPoolSweep] evicted ${evicted} idle entries; ${stats.size} active, ${stats.refCountTotal} held`)
      }
    } catch (e) {
      // Eviction itself shouldn't throw (the pool wraps each teardown
      // step in try/catch) but a future code change could regress this.
      // Capture so we notice without disrupting the next tick.
      Sentry.captureException(e, {
        tags: { component: 'yDocPoolSweep', event: 'tick_failed' }
      })
    } finally {
      running = false
    }
  }

  // First tick after one interval — no need to fire at boot since the
  // pool is empty and there's nothing to evict.
  const intervalTimer = setInterval(tick, TICK_INTERVAL_MS)

  nitroApp.hooks.hook('close', () => {
    clearInterval(intervalTimer)
    // Force-close every entry on shutdown so in-flight WS connections
    // drain instead of getting killed mid-handshake. Mirrors the pg
    // pool + Valkey client shutdown in `99-shutdown.ts`.
    try {
      closeAll()
    } catch (e) {
      console.warn('[yDocPoolSweep] closeAll failed during shutdown:', e instanceof Error ? e.message : e)
    }
  })
})
