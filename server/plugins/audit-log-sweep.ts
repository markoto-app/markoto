import { runAuditLogSweep, resolveAuditLogRetentionDays } from '../utils/privacy/legalRetentionSweep'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { SWEEPS } from '../config/sweeps'

// Enforces the 2-year audit-log retention stated in the privacy policy (§5)
// and the DPA (`NUXT_AUDIT_LOG_RETENTION_DAYS`, default 730, 0 = keep forever).
// See `utils/legalRetentionSweep.ts`.

export default defineSweeper({
  name: 'audit-log-sweep',
  schedule: SWEEPS.auditLog,
  run: async () => {
    const deleted = await runAuditLogSweep({ retentionDays: resolveAuditLogRetentionDays() })
    return deleted > 0 ? { deleted } : undefined
  }
})
