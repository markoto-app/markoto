import { migrationsComplete } from '../utils/migrations'
import { runPlanLapseSweep } from '../utils/planLapseSweep'
import { acquireSweepLock, releaseSweepLock } from '../utils/sweepLock'
import { isBillingEnabled } from '../utils/billingMode'

// Plan-lapse sweep plugin. Thin wrapper — all the query logic lives
// in `server/utils/planLapseSweep.ts` so it's importable from tests
// without pulling in the `defineNitroPlugin` auto-import.
//
// Interval: hourly. The resolver handles real-time correctness; this
// sweep only cleans up stale state for the DB and the admin UI's
// "(+) enabled" badge.

const SWEEP_INTERVAL_MS = 60 * 60 * 1000 // 1h

// Cross-instance lock wrapper. Idempotent today (the resolver makes
// real-time correctness independent of this sweep), so the lock is
// purely a wastefulness guard against N instances doing N× the work.
async function lockedRun(): Promise<void> {
  if (!await acquireSweepLock('plan-lapse-sweep')) return
  try {
    await runPlanLapseSweep()
  } finally {
    await releaseSweepLock('plan-lapse-sweep')
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
