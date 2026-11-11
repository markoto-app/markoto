import { migrationsComplete } from '../utils/platform/migrations'
import { runSpendLogsSweep } from '../utils/litellm/spendLogsSweep'
import { acquireSweepLock, releaseSweepLock } from '../utils/platform/sweepLock'
import { SWEEPS } from '../config/sweeps'

// LiteLLM_SpendLogs sweep plugin: advisory-locked, daily cadence,
// fire-and-forget on startup.
//
// Daily, not hourly: the table grows by one row per billable AI call, so
// a day's growth is bounded and hourly runs would only add log noise.
// Revisit if 24h of growth ever approaches the 90-day total.

const { intervalMs: SWEEP_INTERVAL_MS } = SWEEPS.spendLogs

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
