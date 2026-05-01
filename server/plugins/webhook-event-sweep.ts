import { migrationsComplete } from '../utils/migrations'
import { runWebhookEventSweep } from '../utils/webhookEventSweep'
import { acquireSweepLock, releaseSweepLock } from '../utils/sweepLock'

// Webhook event-table sweep plugin. Thin wrapper — the query logic
// lives in `server/utils/webhookEventSweep.ts` so tests can drive it
// directly without pulling in the `defineNitroPlugin` auto-import.
//
// Runs daily. The handler's correctness doesn't depend on this sweep
// (the ON CONFLICT DO NOTHING in `processed_webhook_events` already
// makes replay short-circuit O(1) regardless of table size); the
// sweep is purely a storage-cost guard. 24h cadence is plenty.

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000 // 1 day

async function lockedRun(): Promise<void> {
  if (!await acquireSweepLock('webhook-event-sweep')) return
  try {
    await runWebhookEventSweep()
  } finally {
    await releaseSweepLock('webhook-event-sweep')
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
