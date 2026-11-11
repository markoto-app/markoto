import * as Sentry from '@sentry/nuxt'
import { migrationsComplete } from '../utils/platform/migrations'
import { resolveImageGcRetentionDays, runImageGc } from '../utils/storage/imageGc'
import { acquireSweepLock, releaseSweepLock } from '../utils/platform/sweepLock'
import { s3ObjectStore } from '../utils/storage/objectStore'
import { SWEEPS } from '../config/sweeps'

// Garbage-collects document images that are referenced nowhere — not in
// the doc, not in any version that can still be restored, not in another
// doc, theme or comment — for longer than NUXT_IMAGE_GC_RETENTION_DAYS
// (default 30; 0 disables). The safety argument lives in
// `server/utils/storage/imageGc.ts`. Every 6 h, first run 10 min after boot (the
// work is a background chore, never urgent).

const { intervalMs: SWEEP_INTERVAL_MS, startupDelayMs: FIRST_RUN_DELAY_MS } = SWEEPS.imageGc

async function lockedRun(): Promise<void> {
  if (resolveImageGcRetentionDays() <= 0) return
  if (!await acquireSweepLock('image-gc')) return
  try {
    const res = await runImageGc({ store: s3ObjectStore(useS3Client(), useRuntimeConfig().s3.bucket) })
    if (res.deleted > 0) {
      console.log(`[image-gc] checked ${res.docsChecked} doc(s), deleted ${res.deleted} unreferenced image(s)`)
    }
  } catch (e) {
    console.error('[image-gc] sweep failed:', e instanceof Error ? e.message : e)
    Sentry.captureException(e, { tags: { component: 'image-gc', event: 'sweep_failed' } })
  } finally {
    await releaseSweepLock('image-gc')
  }
}

export default defineNitroPlugin((nitroApp) => {
  const startupTimer = setTimeout(() => {
    void (async () => {
      await migrationsComplete
      await lockedRun()
    })()
  }, FIRST_RUN_DELAY_MS)
  const timer = setInterval(() => {
    void lockedRun()
  }, SWEEP_INTERVAL_MS)
  nitroApp.hooks.hook('close', () => {
    clearTimeout(startupTimer)
    clearInterval(timer)
  })
})
