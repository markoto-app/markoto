import { migrationsComplete } from '../utils/migrations'
import { runPlanLapseSweep } from '../utils/planLapseSweep'

// Plan-lapse sweep plugin. Thin wrapper — all the query logic lives
// in `server/utils/planLapseSweep.ts` so it's importable from tests
// without pulling in the `defineNitroPlugin` auto-import.
//
// Interval: hourly. The resolver handles real-time correctness; this
// sweep only cleans up stale state for the DB and the admin UI's
// "(+) enabled" badge.

const SWEEP_INTERVAL_MS = 60 * 60 * 1000 // 1h

export default defineNitroPlugin((nitroApp) => {
  void (async () => {
    await migrationsComplete
    await runPlanLapseSweep()
  })()

  const timer = setInterval(() => { void runPlanLapseSweep() }, SWEEP_INTERVAL_MS)
  nitroApp.hooks.hook('close', () => clearInterval(timer))
})
