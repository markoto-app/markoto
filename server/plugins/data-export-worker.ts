import { runDataExportWorker } from '../utils/privacy/dataExportWorker'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { SWEEPS } from '../config/sweeps'

// Runs the queued-job claim → ZIP build → S3 upload pipeline once a minute, so
// a requested export completes within about a minute. The heavy lifting lives
// in `dataExportWorker.ts` so tests can import it.
//
// The repo's claim uses `SELECT … FOR UPDATE SKIP LOCKED`, so two concurrent
// claims pick different rows by design — the lock just keeps the noise floor
// low and ensures one S3 PUT per tick.

export default defineSweeper({
  name: 'data-export-worker',
  schedule: SWEEPS.dataExportWorker,
  run: async () => {
    const result = await runDataExportWorker()
    return result.jobId ? result : undefined
  }
})
