import { migrationsComplete } from '../utils/migrations'
import { runSpendLogsSweep } from '../utils/litellm/spendLogsSweep'
import { acquireSweepLock, releaseSweepLock } from '../utils/sweepLock'

// LiteLLM_SpendLogs sweep plugin. Mirrors the webhook-event-sweep
// pattern: advisory-locked, daily cadence, fire-and-forget on
// startup.
//
// Why daily and not hourly: the proxy's spend-logs table grows by
// one row per billable AI call. At our scale (small VPS, single-
// digit AI calls/min worst-case), a day's growth is bounded; running
// hourly would add noise to the proxy's own logs without measurable
// benefit. If we ever scale to where 24h growth approaches the
// 90-day total, revisit.

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000 // 1 day

async function lockedRun(): Promise<void> {
  if (!await acquireSweepLock('spend-logs-sweep')) return
  try {
    await runSpendLogsSweep()
  } finally {
    await releaseSweepLock('spend-logs-sweep')
  }
}

export default defineNitroPlugin((nitroApp) => {
  void (async () => {
    await migrationsComplete
    await lockedRun()
  })()

  const timer = setInterval(() => {
    void lockedRun()
  }, SWEEP_INTERVAL_MS)
  nitroApp.hooks.hook('close', () => clearInterval(timer))
})
