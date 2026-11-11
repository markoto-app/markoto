import { lt } from 'drizzle-orm'
import * as Sentry from '@sentry/nuxt'
import { mcpSessions } from '../db/schema'
import { useDatabase } from '../utils/platform/database'
import { migrationsComplete } from '../utils/platform/migrations'
import { acquireSweepLock, releaseSweepLock } from '../utils/platform/sweepLock'

// Periodic prune of stale `mcp_sessions` rows.
//
// Why this exists: every MCP client connection (Claude Desktop /
// Cursor / ChatGPT app store / ad-hoc scripts) gets a fresh
// `Mcp-Session-Id` from the toolkit, which we record in
// `mcp_sessions` for audit-attribution. There's no termination
// signal we capture (the toolkit handles its own session lifecycle
// silently). Without this sweeper the table grows monotonically —
// one row per conversation, forever.
//
// Policy: hard-delete rows where `last_active_at < now - 90 days`.
// 90 days mirrors the `processed_webhook_events` retention (matches
// the project's documented forensic-window convention). Activity
// log rows referencing dead sessions still carry their
// `actor_principal` text — they just lose the JOIN back to a human
// user. That's acceptable for entries that old (Activity Log itself
// caps at 500 rows per doc, so most agent rows expire long before
// the 90-day mark anyway).
//
// Throttling: not needed — the sweeper does one bulk DELETE WHERE
// last_active_at < cutoff. Drizzle handles this efficiently via the
// `idx_mcp_sessions_user` index's secondary key on last_active_at.
// Daily cadence is plenty.

const STARTUP_DELAY_MS = 30_000
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
const IDLE_THRESHOLD_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

let running = false

async function sweep(): Promise<void> {
  if (running) return
  running = true
  // Cross-instance dedup. The advisory lock is session-pinned to the
  // PoolClient; release in finally.
  if (!(await acquireSweepLock('mcp-sessions-sweep'))) {
    running = false
    return
  }
  try {
    await migrationsComplete

    const cutoff = new Date(Date.now() - IDLE_THRESHOLD_DAYS * DAY_MS)
    const db = useDatabase()
    const result = await db.delete(mcpSessions)
      .where(lt(mcpSessions.lastActiveAt, cutoff))
      .returning({ id: mcpSessions.id })
    if (result.length > 0) {
      console.log(`[mcp-sessions-sweep] pruned ${result.length} stale sessions (idle > ${IDLE_THRESHOLD_DAYS}d)`)
    }
  } catch (e) {
    console.warn('[mcp-sessions-sweep] sweep failed:', e instanceof Error ? e.message : e)
    Sentry.captureException(e, {
      tags: { component: 'mcp-sessions-sweep', event: 'sweep_failed' }
    })
  } finally {
    await releaseSweepLock('mcp-sessions-sweep')
    running = false
  }
}

export default defineNitroPlugin((nitroApp) => {
  const startupTimer = setTimeout(() => {
    void sweep()
  }, STARTUP_DELAY_MS)
  const intervalTimer = setInterval(() => {
    void sweep()
  }, SWEEP_INTERVAL_MS)

  nitroApp.hooks.hook('close', () => {
    clearTimeout(startupTimer)
    clearInterval(intervalTimer)
  })
})
