import { migrationsComplete } from '../utils/platform/migrations'
import { runDataExportExpirySweep } from '../utils/privacy/dataExportExpirySweep'
import { acquireSweepLock, releaseSweepLock } from '../utils/platform/sweepLock'
import { SWEEPS } from '../config/sweeps'

// Hourly sweeper that expires `ready` data-export jobs past their
// `expires_at` and deletes the corresponding S3 blobs.

const { intervalMs: SWEEP_INTERVAL_MS } = SWEEPS.dataExportExpiry

async function lockedRun(): Promise<void> {
  if (!await acquireSweepLock('data-export-expiry-sweep')) return
  try {
    await runDataExportExpirySweep()
  } finally {
    await releaseSweepLock('data-export-expiry-sweep')
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
