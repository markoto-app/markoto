import * as Sentry from '@sentry/nuxt'
import { migrationsComplete } from '../utils/platform/migrations'
import { runAbuseReportSweep, resolveAbuseReportRetentionDays } from '../utils/privacy/legalRetentionSweep'
import { acquireSweepLock, releaseSweepLock } from '../utils/platform/sweepLock'

// Deletes abuse reports 1 year after they were closed (actioned / dismissed),
// as the privacy policy (§2b) and the abuse policy state
// (`NUXT_ABUSE_REPORT_RETENTION_DAYS`, default 365, 0 = keep forever).
// See `utils/legalRetentionSweep.ts`.
//
// Mirrors `ai-records-sweep`: advisory-locked (cross-instance dedup),
// startup delay, daily cadence.

const NAME = 'abuse-report-sweep'
const STARTUP_DELAY_MS = 50_000
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

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
    const days = resolveAbuseReportRetentionDays()
    const deleted = await runAbuseReportSweep({ retentionDays: days })
    if (deleted > 0) {
      console.log(`[${NAME}] deleted ${deleted} closed abuse report(s) older than ${days}d`)
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
