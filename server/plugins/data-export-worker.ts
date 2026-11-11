import { migrationsComplete } from '../utils/platform/migrations'
import { runDataExportWorker } from '../utils/privacy/dataExportWorker'
import { acquireSweepLock, releaseSweepLock } from '../utils/platform/sweepLock'

// Data-export worker plugin. Runs the queued-job claim → ZIP build
// → S3 upload pipeline. Thin wrapper — the heavy lifting lives in
// `dataExportWorker.ts` so it's importable from tests.
//
// Interval: 1 minute. Trades worker latency for DB scan frequency.
// A user requesting an export sees their job complete within
// roughly a minute on average (immediate if the queue is empty
// when their request lands).
//
// Cross-instance lock: same pattern as the deletion sweeper. The
// repo's claim uses `SELECT … FOR UPDATE SKIP LOCKED` so two
// concurrent claims pick different rows by design — but the lock
// keeps the noise floor low and ensures one S3 PUT per tick.

const WORKER_INTERVAL_MS = 60 * 1000 // 1 min

async function lockedRun(): Promise<void> {
  if (!await acquireSweepLock('data-export-worker')) return
  try {
    await runDataExportWorker()
  } finally {
    await releaseSweepLock('data-export-worker')
  }
}

export default defineNitroPlugin((nitroApp) => {
  void (async () => {
    await migrationsComplete
    await lockedRun()
  })()

  const timer = setInterval(() => {
    void lockedRun()
  }, WORKER_INTERVAL_MS)
  nitroApp.hooks.hook('close', () => clearInterval(timer))
})
