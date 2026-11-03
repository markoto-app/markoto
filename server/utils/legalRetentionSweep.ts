import { and, inArray, isNotNull, lt } from 'drizzle-orm'
import { abuseReports, auditLog } from '../db/schema'
import { useDatabase } from './database'

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
const DAY_MS = 24 * 60 * 60 * 1000

type Env = Record<string, string | undefined>

function resolveDays(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) return fallback
  return n
}

/** `NUXT_AUDIT_LOG_RETENTION_DAYS`; `0` disables the sweep. Absent / invalid → 730. */
export function resolveAuditLogRetentionDays(env: Env = process.env): number {
  return resolveDays(env.NUXT_AUDIT_LOG_RETENTION_DAYS, AUDIT_LOG_DEFAULT_RETENTION_DAYS)
}

/** `NUXT_ABUSE_REPORT_RETENTION_DAYS`; `0` disables the sweep. Absent / invalid → 365. */
export function resolveAbuseReportRetentionDays(env: Env = process.env): number {
  return resolveDays(env.NUXT_ABUSE_REPORT_RETENTION_DAYS, ABUSE_REPORT_DEFAULT_RETENTION_DAYS)
}

/** Delete audit-log rows older than the retention window. Returns the count. */
export async function runAuditLogSweep(
  opts: { now?: number, retentionDays?: number } = {}
): Promise<number> {
  const retentionDays = opts.retentionDays ?? resolveAuditLogRetentionDays()
  if (retentionDays === 0) return 0
  const cutoff = new Date((opts.now ?? Date.now()) - retentionDays * DAY_MS)
  const deleted = await useDatabase()
    .delete(auditLog)
    .where(lt(auditLog.ts, cutoff))
    .returning({ id: auditLog.id })
  return deleted.length
}

/** Delete abuse reports closed longer ago than the retention window. Returns the count. */
export async function runAbuseReportSweep(
  opts: { now?: number, retentionDays?: number } = {}
): Promise<number> {
  const retentionDays = opts.retentionDays ?? resolveAbuseReportRetentionDays()
  if (retentionDays === 0) return 0
  const cutoff = new Date((opts.now ?? Date.now()) - retentionDays * DAY_MS)
  const deleted = await useDatabase()
    .delete(abuseReports)
    .where(and(
      inArray(abuseReports.status, ['actioned', 'dismissed']),
      isNotNull(abuseReports.actionedAt),
      lt(abuseReports.actionedAt, cutoff)
    ))
    .returning({ id: abuseReports.id })
  return deleted.length
}
