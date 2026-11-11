import { migrationsComplete } from '../utils/platform/migrations'
import { runWaitlistSweep } from '../utils/privacy/waitlistSweep'
import { acquireSweepLock, releaseSweepLock } from '../utils/platform/sweepLock'

// Hourly sweeper that deletes unconfirmed paid-plans waitlist sign-ups
// past their 7-day confirm window. Logic lives in
// `server/utils/privacy/waitlistSweep.ts` so tests can drive it directly.
// Hourly (not daily) so "deleted after 7 days" is accurate to the hour.

const SWEEP_INTERVAL_MS = 60 * 60 * 1000 // 1h

async function lockedRun(): Promise<void> {
  if (!await acquireSweepLock('waitlist-sweep')) return
  try {
    await runWaitlistSweep()
  } finally {
    await releaseSweepLock('waitlist-sweep')
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
