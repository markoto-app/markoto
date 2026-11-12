import { resolveImageGcRetentionDays, runImageGc } from '../utils/storage/imageGc'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { s3ObjectStore } from '../utils/storage/objectStore'
import { SWEEPS } from '../config/sweeps'
import { useEnv } from '~~/shared/env/load'

// Garbage-collects document images that are referenced nowhere, not in
// the doc, not in any version that can still be restored, not in another
// doc, theme or comment, for longer than NUXT_IMAGE_GC_RETENTION_DAYS
// (default 30; 0 disables). The safety argument lives in
// `server/utils/storage/imageGc.ts`. Every 6 h, first run 10 min after boot (the
// work is a background chore, never urgent).

export default defineSweeper({
  name: 'image-gc',
  schedule: SWEEPS.imageGc,
  // Without taking the lock when the feature is off.
  shouldRun: () => resolveImageGcRetentionDays() > 0,
  run: async () => {
    const result = await runImageGc({ store: s3ObjectStore(useS3Client(), useEnv().storage.bucket) })
    return result.deleted > 0 ? result : undefined
  }
})
