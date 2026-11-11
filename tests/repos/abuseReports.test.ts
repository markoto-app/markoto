import { describe, it, expect, beforeEach } from 'vitest'
import { aliasedTable, desc, eq } from 'drizzle-orm'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser } from '../integration/setup/fixtures'
import { abuseReports, users } from '../../server/db/schema'
import { useDatabase } from '../../server/utils/platform/database'

// Repo tests for the abuse-report table. The HTTP endpoint goes
// through `db.insert(abuseReports).values(...)` directly (no
// repo wrapper), so these tests pin the inserted row's shape AND
// the JOIN shape used by the admin GET — a refactor that breaks
// either is caught here without spinning up the full integration
// stack.

async function insertReport(args: {
  reportId: string
  reporterUserId: number | null
  reporterEmail: string | null
  category: 'illegal_content' | 'copyright' | 'csam' | 'harassment' | 'spam' | 'other'
  body: string
  status?: 'open' | 'acknowledged' | 'actioned' | 'dismissed'
  docId?: string | null
}): Promise<void> {
  const db = testDb()
  await db.query(
    `INSERT INTO abuse_reports
     (report_id, doc_id, reporter_user_id, reporter_email, category, body, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      args.reportId,
      args.docId ?? null,
      args.reporterUserId,
      args.reporterEmail,
      args.category,
      args.body,
      args.status ?? 'open'
    ]
  )
}

describe('abuse_reports — basic insert + read', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('inserts a row with the expected fields', async () => {
    const reporter = await createUser()
    await insertReport({
      reportId: 'rep-test-1',
      reporterUserId: reporter.id,
      reporterEmail: reporter.email,
      category: 'illegal_content',
      body: 'this is a test'
    })

    const db = testDb()
    const r = await db.query<{
      report_id: string
      reporter_user_id: number
      reporter_email: string
      category: string
      body: string
      status: string
      created_at: Date
    }>(
      `SELECT report_id, reporter_user_id, reporter_email, category, body, status, created_at
       FROM abuse_reports WHERE report_id = $1`,
      ['rep-test-1']
    )
    expect(r.rows.length).toBe(1)
    expect(r.rows[0].reporter_user_id).toBe(reporter.id)
    expect(r.rows[0].reporter_email).toBe(reporter.email)
    expect(r.rows[0].category).toBe('illegal_content')
    expect(r.rows[0].body).toBe('this is a test')
    expect(r.rows[0].status).toBe('open')
  })

  it('accepts free-form docId text (no FK constraint)', async () => {
    const reporter = await createUser()
    // 'test' isn't a real doc id; it is accepted as free-form text (no FK).
    await insertReport({
      reportId: 'rep-test-freeform',
      reporterUserId: reporter.id,
      reporterEmail: reporter.email,
      category: 'spam',
      body: 'pasted a typo for the doc id',
      docId: 'test'
    })
    const r = await testDb().query<{ doc_id: string }>(
      `SELECT doc_id FROM abuse_reports WHERE report_id = $1`,
      ['rep-test-freeform']
    )
    expect(r.rows[0].doc_id).toBe('test')
  })

  it('accepts NULL docId for platform-wide reports', async () => {
    const reporter = await createUser()
    await insertReport({
      reportId: 'rep-platform',
      reporterUserId: reporter.id,
      reporterEmail: reporter.email,
      category: 'other',
      body: 'something general',
      docId: null
    })
    const r = await testDb().query<{ doc_id: string | null }>(
      `SELECT doc_id FROM abuse_reports WHERE report_id = $1`,
      ['rep-platform']
    )
    expect(r.rows[0].doc_id).toBeNull()
  })
})

describe('abuse_reports — admin GET join shape', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('joins reporter + actioner (aliased) and falls back to email snapshot when reporter is gone', async () => {
    // Build the same query the admin GET endpoint runs. This
    // makes sure a refactor that changes the column projection
    // is caught at the repo level — the HTTP layer is just a
    // thin wrapper around this select.
    const reporter = await createUser({ name: 'Reporter Alice', email: 'reporter-alice@test.local' })
    const actioner = await createUser({ name: 'Admin Bob', email: 'admin-bob@test.local' })

    await insertReport({
      reportId: 'rep-live',
      reporterUserId: reporter.id,
      reporterEmail: reporter.email,
      category: 'harassment',
      body: 'live reporter row'
    })
    // A second report whose reporter user has been deleted —
    // FK SET NULL leaves reporter_user_id null, but the
    // reporter_email snapshot survives.
    await insertReport({
      reportId: 'rep-deleted',
      reporterUserId: null,
      reporterEmail: 'gone-reporter@test.local',
      category: 'spam',
      body: 'reporter has since deleted their account'
    })
    // Mark `rep-live` as actioned by Bob so the actioner-join
    // path is exercised too.
    await testDb().query(
      `UPDATE abuse_reports SET status='actioned', actioned_by=$1, actioned_at=now() WHERE report_id='rep-live'`,
      [actioner.id]
    )

    const db = useDatabase()
    const reporterAlias = aliasedTable(users, 'reporter')
    const actionerAlias = aliasedTable(users, 'actioner')
    const rows = await db
      .select({
        reportId: abuseReports.reportId,
        reporterUserId: abuseReports.reporterUserId,
        reporterEmailSnapshot: abuseReports.reporterEmail,
        reporterName: reporterAlias.name,
        reporterEmail: reporterAlias.email,
        actionedBy: abuseReports.actionedBy,
        actionedByName: actionerAlias.name
      })
      .from(abuseReports)
      .leftJoin(reporterAlias, eq(reporterAlias.id, abuseReports.reporterUserId))
      .leftJoin(actionerAlias, eq(actionerAlias.id, abuseReports.actionedBy))
      .orderBy(desc(abuseReports.createdAt))

    const byId = Object.fromEntries(rows.map(r => [r.reportId, r]))

    // Live row: both joins succeed, name + email come from the join.
    expect(byId['rep-live']).toMatchObject({
      reporterUserId: reporter.id,
      reporterName: 'Reporter Alice',
      reporterEmail: 'reporter-alice@test.local',
      actionedBy: actioner.id,
      actionedByName: 'Admin Bob'
    })

    // Deleted-reporter row: reporter join returns null, the
    // snapshot column carries the email so the moderator can
    // still email the original reporter.
    expect(byId['rep-deleted']).toMatchObject({
      reporterUserId: null,
      reporterName: null,
      reporterEmail: null,
      reporterEmailSnapshot: 'gone-reporter@test.local',
      actionedBy: null,
      actionedByName: null
    })
  })
})

describe('abuse_reports — FK on user delete', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('SET NULLs reporter_user_id when the reporter user is deleted', async () => {
    const reporter = await createUser({ name: 'Doomed', email: 'doomed@test.local' })
    await insertReport({
      reportId: 'rep-doomed',
      reporterUserId: reporter.id,
      reporterEmail: reporter.email,
      category: 'spam',
      body: 'will outlive its reporter'
    })

    // Direct DELETE (the deletion cascade does this via the
    // executor in real life; we just want to confirm the FK
    // behaviour is correct).
    await testDb().query(`DELETE FROM users WHERE id = $1`, [reporter.id])

    const r = await testDb().query<{ reporter_user_id: number | null, reporter_email: string }>(
      `SELECT reporter_user_id, reporter_email FROM abuse_reports WHERE report_id = $1`,
      ['rep-doomed']
    )
    expect(r.rows[0].reporter_user_id).toBeNull()
    // Email snapshot survives so the moderator still has a
    // contact channel.
    expect(r.rows[0].reporter_email).toBe('doomed@test.local')
  })
})
