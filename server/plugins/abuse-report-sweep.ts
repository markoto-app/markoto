import { runAbuseReportSweep, resolveAbuseReportRetentionDays } from '../utils/privacy/legalRetentionSweep'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { SWEEPS } from '../config/sweeps'

// Deletes abuse reports 1 year after they were closed (actioned / dismissed),
// as the privacy policy (§2b) and the abuse policy state
// (`NUXT_ABUSE_REPORT_RETENTION_DAYS`, default 365, 0 = keep forever).
// See `utils/legalRetentionSweep.ts`.

export default defineSweeper({
  name: 'abuse-report-sweep',
  schedule: SWEEPS.abuseReports,
  run: async () => {
    const deleted = await runAbuseReportSweep({ retentionDays: resolveAbuseReportRetentionDays() })
    return deleted > 0 ? { deleted } : undefined
  }
})
