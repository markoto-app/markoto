import { lt } from 'drizzle-orm'
import { mcpSessions } from '../db/schema'
import { useDatabase } from '../utils/platform/database'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { SWEEPS } from '../config/sweeps'
import { DAY_MS } from '~~/shared/config/units'

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

const { idleAfterDays: IDLE_THRESHOLD_DAYS } = SWEEPS.mcpSessions

export default defineSweeper({
  name: 'mcp-sessions-sweep',
  schedule: SWEEPS.mcpSessions,
  run: async () => {
    const cutoff = new Date(Date.now() - IDLE_THRESHOLD_DAYS * DAY_MS)
    const result = await useDatabase().delete(mcpSessions)
      .where(lt(mcpSessions.lastActiveAt, cutoff))
      .returning({ id: mcpSessions.id })
    return result.length > 0 ? { pruned: result.length, idleAfterDays: IDLE_THRESHOLD_DAYS } : undefined
  }
})
