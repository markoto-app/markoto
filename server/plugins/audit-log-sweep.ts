import * as Sentry from '@sentry/nuxt'
import { migrationsComplete } from '../utils/platform/migrations'
import { runAuditLogSweep, resolveAuditLogRetentionDays } from '../utils/privacy/legalRetentionSweep'
import { acquireSweepLock, releaseSweepLock } from '../utils/platform/sweepLock'
import { SWEEPS } from '../config/sweeps'

// Enforces the 2-year audit-log retention stated in the privacy policy (§5)
// and the DPA (`NUXT_AUDIT_LOG_RETENTION_DAYS`, default 730, 0 = keep forever).
// See `utils/legalRetentionSweep.ts`.
//
// Mirrors `ai-records-sweep`: advisory-locked (cross-instance dedup),
// startup delay, daily cadence.

const NAME = 'audit-log-sweep'
const { startupDelayMs: STARTUP_DELAY_MS, intervalMs: SWEEP_INTERVAL_MS } = SWEEPS.auditLog

let running = false

async function sweep(): Promise<void> {
  if (running) return
  running = true
  // Cross-instance dedup. Session-pinned advisory lock; release in finally.
  if (!(await acquireSweepLock(NAME))) {
    running = false
    return
  }
  try {
    await migrationsComplete
    const days = resolveAuditLogRetentionDays()
    const deleted = await runAuditLogSweep({ retentionDays: days })
    if (deleted > 0) {
      console.log(`[${NAME}] deleted ${deleted} audit-log row(s) older than ${days}d`)
    }
  } catch (e) {
    console.warn(`[${NAME}] sweep failed:`, e instanceof Error ? e.message : e)
    Sentry.captureException(e, {
      tags: { component: NAME, event: 'sweep_failed' }
    })
  } finally {
    await releaseSweepLock(NAME)
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
