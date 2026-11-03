import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createDoc, createUser } from '../setup/fixtures'
import { createAnonDoc, solveAnonChallenge } from '../setup/anonGate'
import { TEST_BILLING_OFF_BASE_URL } from '../setup/env'
import { ANON_ABUSE_REPORT_LIMITS } from '../../../shared/config/anonLimits'

// DSA Art.16 notices without an account + the moderation decision path:
//   - anonymous reports need a fresh ALTCHA (purpose abuse-report) and the
//     Art.16(2) fields (URL, explanation, name + email unless CSAM,
//     good-faith statement); a confirmation of receipt is recorded;
//   - deciding sends the reporter the decision (Art.16(5)) and the owner a
//     statement of reasons (Art.17), or records that none could be sent
//     (anonymous document); removal / restriction is applied to the doc.

async function code(res: Response): Promise<string | undefined> {
  return (await res.json() as { data?: { code?: string } }).data?.code
}

function randomTestIp(): string {
  const octet = () => Math.floor(Math.random() * 250) + 1
  return `198.${octet()}.${octet()}.${octet()}`
}

interface ReportRow {
  reporter_user_id: number | null
  reporter_name: string
  reporter_email: string
  reporter_locale: string
  content_url: string
  doc_id: string
  good_faith_confirmed_at: Date | null
  reporter_ip_truncated: string | null
}

interface QueueItem {
  reportId: string
  contentUrl: string
  decision: { action: string }
  notices: Array<{ kind: string, status: string }>
  reporter: { signedIn: boolean, name: string }
}

interface NoticeRow { kind: string, recipient_role: string, recipient_user_id: number | null, status: string, locale: string, subject: string, body: string }

async function notices(reportId: string): Promise<NoticeRow[]> {
  const r = await testDb().query<NoticeRow>(
    'SELECT kind, recipient_role, recipient_user_id, status, locale, subject, body FROM moderation_notices WHERE report_id = $1 ORDER BY id',
    [reportId]
  )
  return r.rows
}

const VALID = {
  contentUrl: 'https://markoto.app/d/some-doc',
  category: 'spam',
  body: 'This page sells fake pharmaceuticals and links to a scam shop.',
  reporterName: 'Riley Reporter',
  reporterEmail: 'riley@example.org',
  goodFaith: true,
  locale: 'de'
}

async function submitAnon(fields: Record<string, unknown>, opts: { headers?: Record<string, string>, baseUrl?: string } = {}): Promise<Response> {
  const client = anonClient(opts.baseUrl)
  return client.post('/api/abuse-reports', { ...fields, altcha: await solveAnonChallenge(client, 'abuse-report') }, { headers: opts.headers })
}

describe('POST /api/abuse-reports — anonymous (DSA Art.16)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('accepts a complete anonymous notice, stores the Art.16(2) fields and records the receipt', async () => {
    const res = await submitAnon(VALID)
    expect(res.status).toBe(200)
    const { reportId } = await res.json() as { reportId: string }

    const row = (await testDb().query<ReportRow>('SELECT * FROM abuse_reports WHERE report_id = $1', [reportId])).rows[0]
    expect(row.reporter_user_id).toBeNull()
    expect(row.reporter_name).toBe('Riley Reporter')
    expect(row.reporter_email).toBe('riley@example.org')
    expect(row.reporter_locale).toBe('de')
    expect(row.content_url).toBe('https://markoto.app/d/some-doc')
    expect(row.doc_id).toBe('some-doc')
    expect(row.good_faith_confirmed_at).not.toBeNull()

    const sent = await notices(reportId)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ kind: 'receipt', recipient_role: 'reporter', status: 'sent', locale: 'de' })
    expect(sent[0]?.body).toContain(reportId)

    const audit = await testDb().query<{ metadata: { anonymous?: boolean } }>(`SELECT metadata FROM audit_log WHERE action = 'abuse.reported'`)
    expect(audit.rows[0]?.metadata.anonymous).toBe(true)
  })

  it('needs the bot check: missing → 403, a doc-create solution → 403', async () => {
    const missing = await anonClient().post('/api/abuse-reports', VALID)
    expect(missing.status).toBe(403)
    expect(await code(missing)).toBe('anon-gate/bot-check-required')

    const client = anonClient()
    const wrongPurpose = await client.post('/api/abuse-reports', { ...VALID, altcha: await solveAnonChallenge(client, 'doc-create') })
    expect(wrongPurpose.status).toBe(403)
    expect(await code(wrongPurpose)).toBe('anon-gate/bot-check-failed')
  })

  it('requires the location, the explanation and the good-faith statement', async () => {
    expect(await code(await submitAnon({ ...VALID, contentUrl: '  ' }))).toBe('abuse/url-required')
    expect(await code(await submitAnon({ ...VALID, body: 'too short' }))).toBe('abuse/body-too-short')
    expect(await code(await submitAnon({ ...VALID, goodFaith: false }))).toBe('abuse/good-faith-required')
    expect(await code(await submitAnon({ ...VALID, reporterEmail: 'not-an-email' }))).toBe('abuse/invalid-email')
  })

  it('requires name + email, except for CSAM reports (Art.16(2)(c))', async () => {
    const noContact = { ...VALID, reporterName: '', reporterEmail: '' }
    expect(await code(await submitAnon(noContact))).toBe('abuse/contact-required')

    const csam = await submitAnon({ ...noContact, category: 'csam' })
    expect(csam.status).toBe(200)
    const { reportId } = await csam.json() as { reportId: string }
    // The receipt is recorded even though nobody can receive it.
    expect(await notices(reportId)).toMatchObject([{ kind: 'receipt', status: 'not_delivered_no_contact' }])
  })

  it(`limits anonymous reports to ${ANON_ABUSE_REPORT_LIMITS[0]?.max} per hour per client (billing-off server enforces it)`, async () => {
    const max = ANON_ABUSE_REPORT_LIMITS[0]?.max ?? 0
    const headers = { 'x-forwarded-for': randomTestIp() }
    for (let i = 0; i < max; i++) {
      expect((await submitAnon(VALID, { headers, baseUrl: TEST_BILLING_OFF_BASE_URL })).status, `report #${i + 1}`).toBe(200)
    }
    const limited = await submitAnon(VALID, { headers, baseUrl: TEST_BILLING_OFF_BASE_URL })
    expect(limited.status).toBe(429)
    expect(await code(limited)).toBe('abuse/rate-limited')
  })

  it('signed-in reporters need no bot check; name + email default to the profile', async () => {
    const user = await createUser({ name: 'Signed In', email: 'signed@test.local' })
    const client = await loggedInClient(user.id, user.name)
    const res = await client.post('/api/abuse-reports', { contentUrl: 'x', category: 'other', body: 'Something is wrong here.', goodFaith: true })
    expect(res.status).toBe(200)
    const { reportId } = await res.json() as { reportId: string }
    const row = (await testDb().query<{ reporter_name: string, reporter_email: string }>('SELECT reporter_name, reporter_email FROM abuse_reports WHERE report_id = $1', [reportId])).rows[0]
    expect(row).toEqual({ reporter_name: 'Signed In', reporter_email: 'signed@test.local' })
  })
})

describe('moderation decisions → decision notice + statement of reasons', () => {
  beforeEach(async () => {
    await resetDb()
  })

  async function adminClient() {
    const admin = await createUser({ name: 'Mod' })
    await testDb().query('UPDATE users SET is_admin = true WHERE id = $1', [admin.id])
    return loggedInClient(admin.id, admin.name)
  }

  async function reportAgainst(docId: string): Promise<string> {
    const res = await submitAnon({ ...VALID, contentUrl: `http://markoto.localhost/d/${docId}` })
    expect(res.status).toBe(200)
    return (await res.json() as { reportId: string }).reportId
  }

  const REMOVE = { status: 'actioned', decision: { action: 'content_removed', rule: 'phishing_or_fraud', explanation: 'The page imitates a bank login to steal credentials.' } }

  it('removing an owned document deletes it, emails the owner a statement of reasons and the reporter the decision', async () => {
    const owner = await createUser({ name: 'Owner', email: 'owner@test.local' })
    await testDb().query(`UPDATE users SET locale = 'fr' WHERE id = $1`, [owner.id])
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-view', title: 'Totally a bank' })
    const reportId = await reportAgainst(doc.docId)

    const res = await (await adminClient()).patch(`/api/admin/abuse-reports/${reportId}`, REMOVE)
    expect(res.status).toBe(200)
    const json = await res.json() as { outcome: { contentEffect: string, ownerNotice: string, reporterNotice: string } }
    expect(json.outcome).toEqual({ contentEffect: 'removed', ownerNotice: 'sent', reporterNotice: 'sent' })

    expect((await testDb().query('SELECT 1 FROM documents WHERE doc_id = $1', [doc.docId])).rowCount).toBe(0)

    const all = await notices(reportId)
    const statement = all.find(n => n.kind === 'statement_of_reasons')
    expect(statement).toMatchObject({ recipient_role: 'owner', recipient_user_id: owner.id, status: 'sent', locale: 'fr' })
    expect(statement?.body).toContain('Totally a bank')
    expect(statement?.body).toContain('imitates a bank login')
    expect(statement?.body).toContain('Hameçonnage') // French rule label
    const decision = all.find(n => n.kind === 'decision')
    expect(decision).toMatchObject({ recipient_role: 'reporter', status: 'sent', locale: 'de' })
    expect(decision?.body).toContain('Das Dokument wurde entfernt.')

    const row = (await testDb().query<{ decision_action: string, decision_rule: string, decision_explanation: string }>(
      'SELECT decision_action, decision_rule, decision_explanation FROM abuse_reports WHERE report_id = $1', [reportId])).rows[0]
    expect(row).toEqual({ decision_action: 'content_removed', decision_rule: 'phishing_or_fraud', decision_explanation: REMOVE.decision.explanation })

    const audit = await testDb().query(`SELECT 1 FROM audit_log WHERE action = 'doc.deleted' AND metadata->>'reason' = 'moderation'`)
    expect(audit.rowCount).toBe(1)
  })

  it('an anonymous document has nobody to notify: the statement is recorded as not delivered', async () => {
    const created = await createAnonDoc(anonClient())
    const { docId } = await created.json() as { docId: string }
    const reportId = await reportAgainst(docId)

    const res = await (await adminClient()).patch(`/api/admin/abuse-reports/${reportId}`, {
      status: 'actioned',
      decision: { action: 'access_restricted', rule: 'spam_or_seo', explanation: 'SEO spam page, no longer reachable.' }
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { outcome: unknown }).outcome).toEqual({ contentEffect: 'restricted', ownerNotice: 'not_delivered_no_contact', reporterNotice: 'sent' })

    const mode = await testDb().query<{ access_mode: string }>('SELECT access_mode FROM documents WHERE doc_id = $1', [docId])
    expect(mode.rows[0]?.access_mode).toBe('private')
    const statement = (await notices(reportId)).find(n => n.kind === 'statement_of_reasons')
    expect(statement).toMatchObject({ recipient_role: 'owner', recipient_user_id: null, status: 'not_delivered_no_contact' })
    expect(statement?.body).toContain('SEO spam page')
  })

  it('dismissing tells the reporter, owes the owner nothing', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-view' })
    const reportId = await reportAgainst(doc.docId)
    const res = await (await adminClient()).patch(`/api/admin/abuse-reports/${reportId}`, {
      status: 'dismissed',
      decision: { explanation: 'Satire, not a breach of the rules.' }
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { outcome: unknown }).outcome).toEqual({ contentEffect: 'none', ownerNotice: null, reporterNotice: 'sent' })
    expect((await notices(reportId)).map(n => n.kind)).toEqual(['receipt', 'decision'])
    expect((await testDb().query('SELECT 1 FROM documents WHERE doc_id = $1', [doc.docId])).rowCount).toBe(1)
  })

  it('closing without a decision is refused (the explanation is what gets sent)', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const reportId = await reportAgainst(doc.docId)
    const client = await adminClient()
    expect(await code(await client.patch(`/api/admin/abuse-reports/${reportId}`, { status: 'actioned' }))).toBe('abuse/decision-explanation')
    expect(await code(await client.patch(`/api/admin/abuse-reports/${reportId}`, {
      status: 'actioned', decision: { action: 'no_action', rule: 'spam_or_seo', explanation: 'Long enough explanation.' }
    }))).toBe('abuse/decision-action')
    expect(await code(await client.patch(`/api/admin/abuse-reports/${reportId}`, {
      status: 'actioned', decision: { action: 'content_removed', rule: 'made-up', explanation: 'Long enough explanation.' }
    }))).toBe('abuse/decision-rule')
    expect((await testDb().query('SELECT 1 FROM documents WHERE doc_id = $1', [doc.docId])).rowCount).toBe(1)
  })

  it('the admin queue lists the decision and every notice', async () => {
    const created = await createAnonDoc(anonClient())
    const { docId } = await created.json() as { docId: string }
    const reportId = await reportAgainst(docId)
    const client = await adminClient()
    await client.patch(`/api/admin/abuse-reports/${reportId}`, REMOVE)
    const list = await (await client.get('/api/admin/abuse-reports?status=all')).json() as QueueItem[]
    const item = list.find(r => r.reportId === reportId)
    expect(item?.decision.action).toBe('content_removed')
    expect(item?.reporter).toMatchObject({ signedIn: false, name: 'Riley Reporter' })
    expect(item?.notices.map(n => `${n.kind}:${n.status}`)).toEqual(['receipt:sent', 'statement_of_reasons:not_delivered_no_contact', 'decision:sent'])
  })
})
