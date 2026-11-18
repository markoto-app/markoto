import { deleteImportJobsBefore, listAbandonedUploads, requeueStaleImportJobs } from '../repos/imports'
import { system } from '../repos/proofs'
import { runImportWorker } from '../utils/imports/importWorker'
import { s3ObjectStore } from '../utils/storage/objectStore'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { SWEEPS } from '../config/sweeps'
import { useEnv } from '~~/shared/env/load'
import { DAY_MS, HOUR_MS } from '~~/shared/config/units'
import { IMPORT_JOB_RETENTION_DAYS } from '~~/shared/config/imports'

// Bulk imports (server/utils/imports/importWorker.ts). Each run:
//   - queues again a running job whose heartbeat went stale (its instance
//     died; finished files keep their documents);
//   - processes the oldest queued job to its end (one instance at a time:
//     the sweeper lock);
//   - hourly: drops uploads abandoned in `uploading` for a day (their staging
//     files too) and job records finished 30 days ago.

const { staleAfterMs } = SWEEPS.imports
const by = system('import-worker')
let lastHousekeeping = 0

export default defineSweeper({
  name: 'import-worker',
  schedule: SWEEPS.imports,
  run: async () => {
    const now = Date.now()
    const requeued = await requeueStaleImportJobs(by, new Date(now - staleAfterMs))
    const processed = await runImportWorker()
    let reaped = 0
    if (now - lastHousekeeping >= HOUR_MS) {
      lastHousekeeping = now
      const abandoned = await listAbandonedUploads(by, new Date(now - DAY_MS))
      if (abandoned.length > 0) {
        const store = s3ObjectStore(useS3Client(), useEnv().storage.bucket)
        for (const job of abandoned) await store.deleteMany(job.keys).catch(() => {})
        reaped += await deleteImportJobsBefore(by, new Date(now), abandoned.map(j => j.jobId))
      }
      reaped += await deleteImportJobsBefore(by, new Date(now - IMPORT_JOB_RETENTION_DAYS * DAY_MS))
    }
    return requeued + reaped > 0 || processed ? { requeued, reaped, jobId: processed?.jobId ?? null } : undefined
  }
})
