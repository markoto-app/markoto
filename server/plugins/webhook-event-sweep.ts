import { migrationsComplete } from '../utils/platform/migrations'
import { runWebhookEventSweep } from '../utils/billing/webhookEventSweep'
import { acquireSweepLock, releaseSweepLock } from '../utils/platform/sweepLock'
import { isBillingEnabled } from '../utils/billing/billingMode'

// Webhook event-table sweep plugin. Thin wrapper — the query logic
// lives in `server/utils/billing/webhookEventSweep.ts` so tests can drive it
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
  // Stripe-dependent: with billing off there are no paid plans to lapse
  // and no Stripe webhook rows to prune, so the timer never starts.
  // The flag is read once at boot — flipping it needs a restart anyway
  // (the Stripe secrets are validated at boot too).
  if (!isBillingEnabled()) return

  void (async () => {
    await migrationsComplete
    await lockedRun()
  })()

  const timer = setInterval(() => {
    void lockedRun()
  }, SWEEP_INTERVAL_MS)
  nitroApp.hooks.hook('close', () => clearInterval(timer))
})
