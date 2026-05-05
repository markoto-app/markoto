import { migrationsComplete } from '../utils/migrations'
import { runAccountDeletionSweep } from '../utils/accountDeletionSweep'
import { acquireSweepLock, releaseSweepLock } from '../utils/sweepLock'

// Account-deletion sweep plugin. Runs the cascading-purge for users
// whose 30-day grace window has elapsed. Thin wrapper — the heavy
// lifting is in `accountDeletionSweep.ts` so the unit-and-integration
// tests can import it directly.
//
// Interval: hourly. The sweep only acts on users whose grace window
// has elapsed, so frequency just controls how soon after the cutoff
// the cascade actually fires. Hourly hits the right point on the
// curve between "user feels their deletion took effect" and "we're
// not pounding the DB with no-op scans".
//
// Cross-instance lock: same pattern as plan-lapse-sweep. The
// executor is row-level idempotent (deleting an already-deleted doc
// is a no-op), but two instances racing on the same user would still
// produce a flurry of "user not found" / "row already gone" errors;
// the lock keeps the noise floor low.

const SWEEP_INTERVAL_MS = 60 * 60 * 1000 // 1h

async function lockedRun(): Promise<void> {
  if (!await acquireSweepLock('account-deletion-sweep')) return
  try {
    await runAccountDeletionSweep()
  } finally {
    await releaseSweepLock('account-deletion-sweep')
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
