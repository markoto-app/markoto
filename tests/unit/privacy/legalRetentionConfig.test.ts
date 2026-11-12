import { describe, expect, it } from 'vitest'
import {
  resolveAbuseReportRetentionDays,
  resolveAuditLogRetentionDays
} from '../../../server/utils/privacy/legalRetentionSweep'

// Self-hoster knobs for the compliance retention sweeps. Absent or invalid
// values fall back to the periods the hosted privacy policy states.

describe('NUXT_AUDIT_LOG_RETENTION_DAYS', () => {
  it('defaults to 730 days', () => {
    expect(resolveAuditLogRetentionDays({})).toBe(730)
    expect(resolveAuditLogRetentionDays({ NUXT_AUDIT_LOG_RETENTION_DAYS: ' ' })).toBe(730)
  })

  it('accepts a non-negative integer, 0 = keep forever', () => {
    expect(resolveAuditLogRetentionDays({ NUXT_AUDIT_LOG_RETENTION_DAYS: '365' })).toBe(365)
    expect(resolveAuditLogRetentionDays({ NUXT_AUDIT_LOG_RETENTION_DAYS: '0' })).toBe(0)
  })

  it('refuses invalid input (boot validation reports it)', () => {
    for (const raw of ['-1', '1.5', 'two years']) {
      expect(() => resolveAuditLogRetentionDays({ NUXT_AUDIT_LOG_RETENTION_DAYS: raw }), raw).toThrow(/NUXT_AUDIT_LOG_RETENTION_DAYS: expected an integer ≥ 0/)
    }
  })
})

describe('NUXT_ABUSE_REPORT_RETENTION_DAYS', () => {
  it('defaults to 365 days after closing', () => {
    expect(resolveAbuseReportRetentionDays({})).toBe(365)
  })

  it('accepts a non-negative integer, 0 = keep forever', () => {
    expect(resolveAbuseReportRetentionDays({ NUXT_ABUSE_REPORT_RETENTION_DAYS: '730' })).toBe(730)
    expect(resolveAbuseReportRetentionDays({ NUXT_ABUSE_REPORT_RETENTION_DAYS: '0' })).toBe(0)
  })

  it('refuses invalid input (boot validation reports it)', () => {
    expect(() => resolveAbuseReportRetentionDays({ NUXT_ABUSE_REPORT_RETENTION_DAYS: 'x' })).toThrow(/NUXT_ABUSE_REPORT_RETENTION_DAYS/)
  })
})
