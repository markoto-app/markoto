import { runDataExportWorker } from '../../utils/dataExportWorker'
import { isTestModeEnabled } from '../../../shared/utils/testMode'

// Test-only worker-tick. Runs `runDataExportWorker()` once on demand
// so flow tests don't have to poll for 60+ seconds waiting for the
// real plugin's interval to fire.
//
// Same TEST_MODE gate as the other `_test/` endpoints — returns 404
// in any environment where the env var is unset, so an accidentally-
// set TEST_MODE in prod still produces no worker re-runs (which would
// at worst rebuild an export ZIP — not catastrophic, but the
// principle is "no test surface in prod").
export default defineEventHandler(async (_event) => {
  if (!isTestModeEnabled()) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  const result = await runDataExportWorker()
  return result
})
