import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  ABUSE_REPORT_DEFAULT_RETENTION_DAYS,
  AUDIT_LOG_DEFAULT_RETENTION_DAYS,
  runAbuseReportSweep,
  runAuditLogSweep
} from '../../server/utils/privacy/legalRetentionSweep'

// Retention the privacy policy promises: audit-log entries are deleted after
// 2 years (§5); abuse reports 1 year after the case was closed (§2b).

const DAY_MS = 24 * 60 * 60 * 1000

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS)
}

async function insertAudit(action: string, ts: Date): Promise<void> {
  await testDb().query(
    `INSERT INTO audit_log (ts, scope, scope_id, action) VALUES ($1, 'system', NULL, $2)`,
    [ts, action]
  )
}

async function auditActions(): Promise<string[]> {
  const r = await testDb().query<{ action: string }>('SELECT action FROM audit_log ORDER BY action')
  return r.rows.map(row => row.action)
}

async function insertReport(
  reportId: string,
  status: 'open' | 'acknowledged' | 'actioned' | 'dismissed',
  createdAt: Date,
  actionedAt: Date | null
): Promise<void> {
  await testDb().query(
    `INSERT INTO abuse_reports (report_id, category, body, status, created_at, actioned_at)
     VALUES ($1, 'spam', 'body', $2, $3, $4)`,
    [reportId, status, createdAt, actionedAt]
  )
}

async function reportIds(): Promise<string[]> {
  const r = await testDb().query<{ report_id: string }>('SELECT report_id FROM abuse_reports ORDER BY report_id')
  return r.rows.map(row => row.report_id)
}

describe('runAuditLogSweep', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('defaults to 2 years', () => {
    expect(AUDIT_LOG_DEFAULT_RETENTION_DAYS).toBe(730)
  })

  it('deletes entries older than the retention window and keeps newer ones', async () => {
    await insertAudit('recent', daysAgo(1))
    await insertAudit('inside', daysAgo(729))
    await insertAudit('outside', daysAgo(731))

    expect(await runAuditLogSweep({ retentionDays: 730 })).toBe(1)
    expect(await auditActions()).toEqual(['inside', 'recent'])
  })

  it('keeps everything when retention is 0 (self-host opt-out)', async () => {
    await insertAudit('ancient', daysAgo(5000))
    expect(await runAuditLogSweep({ retentionDays: 0 })).toBe(0)
    expect(await auditActions()).toEqual(['ancient'])
  })
})

describe('runAbuseReportSweep', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('defaults to 1 year after closing', () => {
    expect(ABUSE_REPORT_DEFAULT_RETENTION_DAYS).toBe(365)
  })

  it('deletes reports closed more than a year ago, counted from the close date', async () => {
    // Created long ago but closed recently: kept (the clock starts at closing).
    await insertReport('closed-recently', 'actioned', daysAgo(900), daysAgo(30))
    await insertReport('dismissed-old', 'dismissed', daysAgo(800), daysAgo(366))
    await insertReport('actioned-old', 'actioned', daysAgo(800), daysAgo(400))
    await insertReport('dismissed-inside', 'dismissed', daysAgo(400), daysAgo(364))

    expect(await runAbuseReportSweep({ retentionDays: 365 })).toBe(2)
    expect(await reportIds()).toEqual(['closed-recently', 'dismissed-inside'])
  })

  it('never deletes open or acknowledged reports, however old', async () => {
    await insertReport('open-old', 'open', daysAgo(2000), null)
    await insertReport('ack-old', 'acknowledged', daysAgo(2000), null)

    expect(await runAbuseReportSweep({ retentionDays: 365 })).toBe(0)
    expect(await reportIds()).toEqual(['ack-old', 'open-old'])
  })

  it('keeps everything when retention is 0 (self-host opt-out)', async () => {
    await insertReport('dismissed-ancient', 'dismissed', daysAgo(5000), daysAgo(4000))
    expect(await runAbuseReportSweep({ retentionDays: 0 })).toBe(0)
    expect(await reportIds()).toEqual(['dismissed-ancient'])
  })
})
