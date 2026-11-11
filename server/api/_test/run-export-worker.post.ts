import { runDataExportWorker } from '../../utils/privacy/dataExportWorker'

// Test-only worker tick: runs `runDataExportWorker()` once on demand so flow
// tests needn't wait for the plugin's interval. Same TEST_MODE gate as the
// other `_test/` endpoints (404 otherwise).
export default defineApiHandler({
  access: allow.testOnly(),
  body: 'none',
  handler: () => runDataExportWorker()
})
