import { runDataExportExpirySweep } from '../utils/privacy/dataExportExpirySweep'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { SWEEPS } from '../config/sweeps'

// Hourly sweeper that expires `ready` data-export jobs past their
// `expires_at` and deletes the corresponding S3 blobs.

export default defineSweeper({
  name: 'data-export-expiry-sweep',
  schedule: SWEEPS.dataExportExpiry,
  run: async () => {
    const result = await runDataExportExpirySweep()
    return result.expired > 0 ? result : undefined
  }
})
