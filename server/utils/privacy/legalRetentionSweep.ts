import { deleteAuditEventsBefore } from '../../repos/audit'
import { deleteClosedAbuseReportsBefore } from '../../repos/abuseReports'
import { system } from '../../repos/proofs'
import { DAY_MS } from '~~/shared/config/units'
import { useEnv } from '~~/shared/env/load'
import type { RawEnv } from '~~/shared/env/define'

// Retention enforcement for the two compliance tables that grow forever
// otherwise. Both periods are stated in the privacy policy (§2b, §5) and
// the abuse policy; `server/legal/lawfulBasis.ts` carries the same values.
//
//   - `audit_log`: rows older than 2 years (`ts`) are deleted.
//     `NUXT_AUDIT_LOG_RETENTION_DAYS` (default 730, `0` = keep forever).
//   - `abuse_reports`: CLOSED reports (status `actioned` / `dismissed`)
//     are deleted 1 year after they were closed. `actioned_at` is the
//     close timestamp: the admin PATCH stamps it on both terminal
//     statuses, and closed reports can't be reopened. Open / acknowledged
//     reports are never deleted by age. `NUXT_ABUSE_REPORT_RETENTION_DAYS`
//     (default 365, `0` = keep forever).
//
// Run by `server/plugins/audit-log-sweep.ts` and
// `server/plugins/abuse-report-sweep.ts` (advisory-locked, daily).

export const AUDIT_LOG_DEFAULT_RETENTION_DAYS = 730
export const ABUSE_REPORT_DEFAULT_RETENTION_DAYS = 365

/** `NUXT_AUDIT_LOG_RETENTION_DAYS`; `0` disables the sweep. Unset → 730. */
export function resolveAuditLogRetentionDays(source?: RawEnv): number {
  return useEnv(source).legal.auditLogRetentionDays
}

/** `NUXT_ABUSE_REPORT_RETENTION_DAYS`; `0` disables the sweep. Unset → 365. */
export function resolveAbuseReportRetentionDays(source?: RawEnv): number {
  return useEnv(source).legal.abuseReportRetentionDays
}

/** Delete audit-log rows older than the retention window. Returns the count. */
export async function runAuditLogSweep(
  opts: { now?: number, retentionDays?: number } = {}
): Promise<number> {
  const retentionDays = opts.retentionDays ?? resolveAuditLogRetentionDays()
  if (retentionDays === 0) return 0
  const cutoff = new Date((opts.now ?? Date.now()) - retentionDays * DAY_MS)
  return deleteAuditEventsBefore(system('legal-retention-sweep'), cutoff)
}

/** Delete abuse reports closed longer ago than the retention window. Returns the count. */
export async function runAbuseReportSweep(
  opts: { now?: number, retentionDays?: number } = {}
): Promise<number> {
  const retentionDays = opts.retentionDays ?? resolveAbuseReportRetentionDays()
  if (retentionDays === 0) return 0
  const cutoff = new Date((opts.now ?? Date.now()) - retentionDays * DAY_MS)
  return deleteClosedAbuseReportsBefore(system('legal-retention-sweep'), cutoff)
}
