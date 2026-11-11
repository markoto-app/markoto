import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createUser } from '../setup/fixtures'

// Integration tests for the abuse-report HTTP flow:
//   POST /api/abuse-reports                  (submission; anonymous path in abuseReportsAnon.test.ts)
//   GET  /api/admin/abuse-reports            (admin queue list)
//   PATCH /api/admin/abuse-reports/:reportId (status transitions)
//
// Hits the running prod-build Nitro server (spawned by the
// integration setup). Verifies the public + admin contracts +
// the audit trail + the FK behaviour.

async function countReports(): Promise<number> {
  const r = await testDb().query<{ c: string }>(`SELECT COUNT(*) AS c FROM abuse_reports`)
  return Number(r.rows[0].c)
}

async function countAuditByAction(action: string): Promise<number> {
  const r = await testDb().query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM audit_log WHERE action = $1`,
    [action]
  )
  return Number(r.rows[0].c)
}

// The DSA Art.16(2) fields every valid report carries (signed-in
// reporters' name + email default to their profile).
function report(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { contentUrl: 'https://markoto.app/d/some-doc', goodFaith: true, ...extra }
}

const DISMISS = { status: 'dismissed', decision: { explanation: 'Reviewed: nothing against the rules.' } }

async function promoteToAdmin(userId: number): Promise<void> {
  await testDb().query(`UPDATE users SET is_admin = true WHERE id = $1`, [userId])
}

describe('POST /api/abuse-reports', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('anonymous callers need the bot check (403), not a sign-in', async () => {
    const res = await anonClient().request('/api/abuse-reports', {
      method: 'POST',
      body: report({ category: 'spam', body: 'no session here', reporterName: 'A', reporterEmail: 'a@test.local' })
    })
    expect(res.status).toBe(403)
    expect((await res.json() as { data?: { code?: string } }).data?.code).toBe('anon-gate/bot-check-required')
  })

  it('records a row + audit event for a logged-in submission', async () => {
    const reporter = await createUser({ name: 'Maya', email: 'maya@test.local' })
    const client = await loggedInClient(reporter.id, reporter.name)

    expect(await countReports()).toBe(0)

    const res = await client.request('/api/abuse-reports', {
      method: 'POST',
      body: report({
        category: 'illegal_content',
        body: 'this passage describes a real-world threat'
      })
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { ok: boolean, reportId: string }
    expect(json.ok).toBe(true)
    expect(json.reportId).toMatch(/^rep-/)

    expect(await countReports()).toBe(1)

    // Verify the row carries the reporter user id + email snapshot.
    const row = await testDb().query<{
      reporter_user_id: number
      reporter_email: string
      category: string
      status: string
    }>(
      `SELECT reporter_user_id, reporter_email, category, status
       FROM abuse_reports WHERE report_id = $1`,
      [json.reportId]
    )
    expect(row.rows[0].reporter_user_id).toBe(reporter.id)
    expect(row.rows[0].reporter_email).toBe(reporter.email)
    expect(row.rows[0].category).toBe('illegal_content')
    expect(row.rows[0].status).toBe('open')

    // Audit row was appended.
    expect(await countAuditByAction('abuse.reported')).toBe(1)
  })

  it('rejects empty bodies (< 10 chars)', async () => {
    const reporter = await createUser()
    const client = await loggedInClient(reporter.id, reporter.name)
    const res = await client.request('/api/abuse-reports', {
      method: 'POST',
      body: report({ category: 'spam', body: 'short' })
    })
    expect(res.status).toBe(400)
    expect(await countReports()).toBe(0)
  })

  it('rejects unknown categories', async () => {
    const reporter = await createUser()
    const client = await loggedInClient(reporter.id, reporter.name)
    const res = await client.request('/api/abuse-reports', {
      method: 'POST',
      body: report({ category: 'totally-made-up', body: 'a description that exists' })
    })
    expect(res.status).toBe(400)
  })

  it('accepts free-form docId text (no FK constraint)', async () => {
    // There is no FK on doc_id: pasting "test" (or a URL, or anything) should land cleanly.
    const reporter = await createUser()
    const client = await loggedInClient(reporter.id, reporter.name)
    const res = await client.request('/api/abuse-reports', {
      method: 'POST',
      body: {
        docId: 'test',
        goodFaith: true,
        category: 'copyright',
        body: 'reporter pasted a typo for the doc id'
      }
    })
    expect(res.status).toBe(200)
    const { reportId } = await res.json() as { reportId: string }
    const row = await testDb().query<{ doc_id: string }>(
      `SELECT doc_id FROM abuse_reports WHERE report_id = $1`,
      [reportId]
    )
    expect(row.rows[0].doc_id).toBe('test')
  })
})

describe('GET /api/admin/abuse-reports', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns 401 to anonymous, 403 to non-admin, 200 to admin', async () => {
    const anonRes = await anonClient().request('/api/admin/abuse-reports')
    expect(anonRes.status).toBe(401)

    const regular = await createUser()
    const regularClient = await loggedInClient(regular.id, regular.name)
    const regularRes = await regularClient.request('/api/admin/abuse-reports')
    expect(regularRes.status).toBe(403)

    const admin = await createUser()
    await promoteToAdmin(admin.id)
    const adminClient = await loggedInClient(admin.id, admin.name)
    const adminRes = await adminClient.request('/api/admin/abuse-reports')
    expect(adminRes.status).toBe(200)
  })

  it('joins reporter info + falls back to email snapshot when reporter is gone', async () => {
    // Submit one live report + one whose reporter has been
    // deleted (FK SET NULL).
    const liveReporter = await createUser({ name: 'Live', email: 'live@test.local' })
    const liveClient = await loggedInClient(liveReporter.id, liveReporter.name)
    await liveClient.request('/api/abuse-reports', {
      method: 'POST',
      body: report({ category: 'harassment', body: 'live report from active reporter' })
    })

    const goneReporter = await createUser({ name: 'Gone', email: 'gone@test.local' })
    const goneClient = await loggedInClient(goneReporter.id, goneReporter.name)
    await goneClient.request('/api/abuse-reports', {
      method: 'POST',
      body: report({ category: 'spam', body: 'reporter will delete their account' })
    })
    // Simulate post-submission account deletion. FK is ON DELETE
    // SET NULL — reporter_user_id flips to null, email snapshot
    // survives.
    await testDb().query(`DELETE FROM users WHERE id = $1`, [goneReporter.id])

    // Now query as admin.
    const admin = await createUser({ name: 'Admin', email: 'admin@test.local' })
    await promoteToAdmin(admin.id)
    const adminClient = await loggedInClient(admin.id, admin.name)
    const res = await adminClient.request('/api/admin/abuse-reports?status=open')
    expect(res.status).toBe(200)
    const reports = await res.json() as Array<{
      reportId: string
      reporter: { userId: number | null, name: string | null, email: string | null, stillExists: boolean } | null
    }>

    expect(reports.length).toBe(2)
    const live = reports.find(r => r.reporter?.email === 'live@test.local')
    expect(live).toBeTruthy()
    expect(live!.reporter!.userId).toBe(liveReporter.id)
    expect(live!.reporter!.name).toBe('Live')
    expect(live!.reporter!.stillExists).toBe(true)

    const gone = reports.find(r => r.reporter?.email === 'gone@test.local')
    expect(gone).toBeTruthy()
    expect(gone!.reporter!.userId).toBeNull()
    // The name typed (here: defaulted from the profile) at submission
    // survives as a snapshot, like the email.
    expect(gone!.reporter!.name).toBe('Gone')
    // Email snapshot is the surviving channel.
    expect(gone!.reporter!.email).toBe('gone@test.local')
    expect(gone!.reporter!.stillExists).toBe(false)
  })

  it('default filter returns open + acknowledged, "all" returns everything', async () => {
    const admin = await createUser()
    await promoteToAdmin(admin.id)
    const adminClient = await loggedInClient(admin.id, admin.name)

    // Pre-seed three rows in three different statuses.
    await testDb().query(
      `INSERT INTO abuse_reports (report_id, reporter_user_id, reporter_email, category, body, status)
       VALUES
       ('rep-open', NULL, NULL, 'spam', 'open report', 'open'),
       ('rep-ack',  NULL, NULL, 'spam', 'ack report',  'acknowledged'),
       ('rep-act',  NULL, NULL, 'spam', 'actioned report', 'actioned'),
       ('rep-dis',  NULL, NULL, 'spam', 'dismissed report', 'dismissed')`
    )

    // Default → open + acknowledged only.
    const def = await adminClient.request('/api/admin/abuse-reports')
    const defJson = await def.json() as Array<{ reportId: string }>
    const defIds = defJson.map(r => r.reportId).sort()
    expect(defIds).toEqual(['rep-ack', 'rep-open'])

    // status=all → all four.
    const all = await adminClient.request('/api/admin/abuse-reports?status=all')
    const allJson = await all.json() as Array<{ reportId: string }>
    expect(allJson.length).toBe(4)

    // Specific status filter.
    const dismissed = await adminClient.request('/api/admin/abuse-reports?status=dismissed')
    const dismissedJson = await dismissed.json() as Array<{ reportId: string }>
    expect(dismissedJson.map(r => r.reportId)).toEqual(['rep-dis'])
  })
})

describe('PATCH /api/admin/abuse-reports/:reportId', () => {
  beforeEach(async () => {
    await resetDb()
  })

  async function seedOpenReport(): Promise<string> {
    await testDb().query(
      `INSERT INTO abuse_reports (report_id, category, body, status)
       VALUES ('rep-fixture', 'spam', 'a fixture report', 'open')`
    )
    return 'rep-fixture'
  }

  it('rejects non-admin', async () => {
    const reportId = await seedOpenReport()
    const regular = await createUser()
    const client = await loggedInClient(regular.id, regular.name)
    const res = await client.request(`/api/admin/abuse-reports/${reportId}`, {
      method: 'PATCH',
      body: { status: 'acknowledged' }
    })
    expect(res.status).toBe(403)
  })

  it('admin can transition open → acknowledged + writes audit row', async () => {
    const reportId = await seedOpenReport()
    const admin = await createUser()
    await promoteToAdmin(admin.id)
    const client = await loggedInClient(admin.id, admin.name)

    const res = await client.request(`/api/admin/abuse-reports/${reportId}`, {
      method: 'PATCH',
      body: { status: 'acknowledged', notes: 'reviewing now' }
    })
    expect(res.status).toBe(200)

    const row = await testDb().query<{ status: string, actioned_by: number, notes: string, acknowledged_at: Date | null }>(
      `SELECT status, actioned_by, notes, acknowledged_at FROM abuse_reports WHERE report_id = $1`,
      [reportId]
    )
    expect(row.rows[0].status).toBe('acknowledged')
    expect(row.rows[0].actioned_by).toBe(admin.id)
    expect(row.rows[0].notes).toBe('reviewing now')
    expect(row.rows[0].acknowledged_at).not.toBeNull()

    expect(await countAuditByAction('abuse.acknowledged')).toBe(1)
  })

  it('admin can transition straight from open → actioned (skipping acknowledged)', async () => {
    const reportId = await seedOpenReport()
    const admin = await createUser()
    await promoteToAdmin(admin.id)
    const client = await loggedInClient(admin.id, admin.name)

    const res = await client.request(`/api/admin/abuse-reports/${reportId}`, {
      method: 'PATCH',
      body: { status: 'actioned', decision: { action: 'content_removed', rule: 'spam_or_seo', explanation: 'Spam page, removed.' } }
    })
    expect(res.status).toBe(200)

    const row = await testDb().query<{ status: string, acknowledged_at: Date | null, actioned_at: Date | null }>(
      `SELECT status, acknowledged_at, actioned_at FROM abuse_reports WHERE report_id = $1`,
      [reportId]
    )
    expect(row.rows[0].status).toBe('actioned')
    // Both timestamps stamped — even though we skipped the
    // explicit acknowledge step, ops will want to know "we saw
    // it at X" regardless.
    expect(row.rows[0].acknowledged_at).not.toBeNull()
    expect(row.rows[0].actioned_at).not.toBeNull()

    expect(await countAuditByAction('abuse.actioned')).toBe(1)
  })

  it('refuses backwards transitions (closed → open) with 409', async () => {
    // Pre-seed an actioned report.
    await testDb().query(
      `INSERT INTO abuse_reports (report_id, category, body, status, actioned_at)
       VALUES ('rep-closed', 'spam', 'already closed', 'actioned', now())`
    )
    const admin = await createUser()
    await promoteToAdmin(admin.id)
    const client = await loggedInClient(admin.id, admin.name)

    const res = await client.request('/api/admin/abuse-reports/rep-closed', {
      method: 'PATCH',
      body: { status: 'acknowledged' }
    })
    expect(res.status).toBe(409)
    const json = await res.json() as { data?: { code?: string } }
    expect(json.data?.code).toBe('abuse/already-closed')
  })

  it('returns 404 for unknown reportId', async () => {
    const admin = await createUser()
    await promoteToAdmin(admin.id)
    const client = await loggedInClient(admin.id, admin.name)
    const res = await client.request('/api/admin/abuse-reports/rep-nope', {
      method: 'PATCH',
      body: DISMISS
    })
    expect(res.status).toBe(404)
  })

  it('rejects invalid status values with 400', async () => {
    const reportId = await seedOpenReport()
    const admin = await createUser()
    await promoteToAdmin(admin.id)
    const client = await loggedInClient(admin.id, admin.name)
    const res = await client.request(`/api/admin/abuse-reports/${reportId}`, {
      method: 'PATCH',
      body: { status: 'totally-made-up' }
    })
    expect(res.status).toBe(400)
  })
})
