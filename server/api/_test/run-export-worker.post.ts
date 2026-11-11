import { runDataExportWorker } from '../../utils/privacy/dataExportWorker'
import { isTestModeEnabled } from '../../../shared/utils/security/testMode'

// Test-only worker tick: runs `runDataExportWorker()` once on demand so flow
// tests needn't wait for the plugin's interval. Same TEST_MODE gate as the
// other `_test/` endpoints (404 otherwise).
export default defineEventHandler(async (_event) => {
  if (!isTestModeEnabled()) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  const result = await runDataExportWorker()
  return result
})
