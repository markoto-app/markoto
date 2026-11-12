import { describe, it, expect, beforeEach, vi } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import * as Y from 'yjs'
import { insertYjsUpdate, resetDb, testDb } from '../integration/setup/db'
import {
  createDoc,
  createUser,
  createWorkspace,
  setMemberRole
} from '../integration/setup/fixtures'
import { sys } from '../helpers/access'

// Stripe stub — we don't want the export builder hitting the network.
vi.mock('../../server/utils/billing/stripeClient', () => ({
  useStripeClient: () => null
}))

const { buildExportZip } = await import('../../server/utils/privacy/dataExport')

async function insertComment(args: {
  docId: string
  entryId: string
  authorId: number
  authorName: string
  body: string
}): Promise<void> {
  const db = testDb()
  await db.query(
    `INSERT INTO document_comments (doc_id, entry_id, author_id, author_name, body, created_at_ms, updated_at_ms)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
    [args.docId, args.entryId, args.authorId, args.authorName, args.body]
  )
}

function entryNames(zipBytes: Uint8Array): string[] {
  return Object.keys(unzipSync(zipBytes)).sort()
}

function readEntry(zipBytes: Uint8Array, name: string): string {
  const entries = unzipSync(zipBytes)
  if (!entries[name]) throw new Error(`Missing entry: ${name}`)
  return strFromU8(entries[name])
}

describe('buildExportZip', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('throws when the user does not exist', async () => {
    await expect(buildExportZip(sys(), 99_999_999)).rejects.toThrow(/not found/)
  })

  it('emits the canonical layout for a brand-new user with no data', async () => {
    const u = await createUser()
    const result = await buildExportZip(sys(), u.id)
    expect(result.bytes.byteLength).toBeGreaterThan(0)

    const names = entryNames(result.bytes)
    expect(names).toEqual([
      'README.txt',
      'abuse_reports.ndjson',
      'activity.ndjson',
      'ai/edit-provenance.ndjson',
      'ai/messages.ndjson',
      'ai/providers.json',
      'ai/sessions.ndjson',
      'audit.ndjson',
      'billing/ai_credits.json',
      'billing/customer.json',
      'billing/invoices.ndjson',
      'billing/workspace_subscriptions.json',
      'brand_assets.json',
      'comments.ndjson',
      'consent.ndjson',
      'custom_domains.json',
      'document_shares.json',
      'moderation_notices.ndjson',
      'profile.json',
      'published_pages.json',
      'sso_identities.json',
      'themes.json',
      'waitlist.ndjson',
      'workspace_invites.json',
      'workspace_memberships.json'
    ].sort())

    // Empty data files exist but contain zero rows.
    expect(readEntry(result.bytes, 'comments.ndjson')).toBe('')
    expect(readEntry(result.bytes, 'consent.ndjson')).toBe('')
    expect(readEntry(result.bytes, 'workspace_memberships.json')).toBe('[]')
    expect(readEntry(result.bytes, 'themes.json')).toBe('[]')
    expect(readEntry(result.bytes, 'waitlist.ndjson')).toBe('')
    expect(result.counts.waitlistSignups).toBe(0)
    expect(JSON.parse(readEntry(result.bytes, 'workspace_invites.json'))).toEqual({ received: [], sent: [] })

    // README is non-empty + describes the layout.
    const readme = readEntry(result.bytes, 'README.txt')
    expect(readme).toContain('markoto data export')
    expect(readme).toContain('GDPR Article 15')

    // profile.json shape — projection only, no password hash.
    const profile = JSON.parse(readEntry(result.bytes, 'profile.json'))
    expect(profile.id).toBe(u.id)
    expect(profile.email).toBe(u.email)
    expect(profile).not.toHaveProperty('passwordHash')
    expect(profile).not.toHaveProperty('githubId')
    expect(profile).not.toHaveProperty('googleId')
    expect(profile.githubLinked).toBe(true) // createUser sets gh-…
    expect(profile).not.toHaveProperty('oidcSubject')
    expect(profile.oidcLinked).toBe(false)
    expect(profile.oidcIssuer).toBeNull()
  })

  it('includes the reports the user filed and the notices sent to them, never moderator notes or the owner\'s data', async () => {
    const reporter = await createUser({ name: 'Rita', email: 'rita@example.org' })
    const owner = await createUser({ name: 'Owner', email: 'owner@example.org' })
    const db = testDb()
    await db.query(
      `INSERT INTO abuse_reports (report_id, doc_id, content_url, reporter_user_id, reporter_email, reporter_name, reporter_locale,
         good_faith_confirmed_at, category, body, status, notes, actioned_by, decision_action, decision_rule, decision_explanation, actioned_at)
       VALUES ('rep-mine', 'doc-x', 'https://markoto.app/d/doc-x', $1, 'rita@example.org', 'Rita', 'de', NOW(),
         'spam', 'Scam page selling fake watches.', 'actioned', 'INTERNAL moderator note', $2, 'content_removed', 'spam_or_seo', 'Removed as spam.', NOW()),
       ('rep-other', 'doc-y', 'https://markoto.app/d/doc-y', $2, 'owner@example.org', 'Owner', 'en', NOW(), 'spam', 'Someone else reported this.', 'open', NULL, NULL, NULL, NULL, NULL, NULL)`,
      [reporter.id, owner.id]
    )
    await db.query(
      `INSERT INTO moderation_notices (notice_id, report_id, kind, recipient_role, recipient_user_id, status, locale, subject, body)
       VALUES ('ntc-1', 'rep-mine', 'receipt', 'reporter', $1, 'sent', 'de', 'Wir haben Ihre Meldung erhalten', 'receipt body'),
              ('ntc-2', 'rep-mine', 'decision', 'reporter', $1, 'sent', 'de', 'Entscheidung', 'decision body'),
              ('ntc-3', 'rep-mine', 'statement_of_reasons', 'owner', $2, 'sent', 'en', 'We removed one of your documents', 'statement body for the OWNER')`,
      [reporter.id, owner.id]
    )

    const mine = await buildExportZip(sys(), reporter.id)
    const raw = readEntry(mine.bytes, 'abuse_reports.ndjson')
    expect(raw).not.toContain('INTERNAL moderator note')
    expect(raw).not.toContain('statement body for the OWNER')
    expect(raw).not.toContain('Someone else reported this')
    const rows = raw.trim().split('\n').map(l => JSON.parse(l))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      reportId: 'rep-mine',
      contentUrl: 'https://markoto.app/d/doc-x',
      reporterName: 'Rita',
      reporterEmail: 'rita@example.org',
      status: 'actioned',
      decision: { action: 'content_removed', rule: 'spam_or_seo', explanation: 'Removed as spam.' }
    })
    expect(Object.keys(rows[0])).not.toContain('notes')
    expect(Object.keys(rows[0])).not.toContain('actionedBy')
    expect(rows[0].noticesSentToYou.map((n: { kind: string }) => n.kind)).toEqual(['receipt', 'decision'])
    expect(mine.counts.abuseReports).toBe(1)
    expect(readEntry(mine.bytes, 'moderation_notices.ndjson')).toBe('')

    // The owner sees the statement of reasons they got, nothing of the reporter.
    const theirs = await buildExportZip(sys(), owner.id)
    const notices = readEntry(theirs.bytes, 'moderation_notices.ndjson').trim().split('\n').map(l => JSON.parse(l))
    expect(notices).toEqual([expect.objectContaining({ kind: 'statement_of_reasons', body: 'statement body for the OWNER', reference: 'rep-mine' })])
    expect(JSON.stringify(notices)).not.toContain('rita@example.org')
    expect(theirs.counts.moderationNotices).toBe(1)
    // Their own (open) report is in their abuse_reports, without notices.
    const ownRows = readEntry(theirs.bytes, 'abuse_reports.ndjson').trim().split('\n').map(l => JSON.parse(l))
    expect(ownRows.map((r: { reportId: string }) => r.reportId)).toEqual(['rep-other'])
  })

  it('reports a linked OIDC identity by issuer, never by subject', async () => {
    const u = await createUser()
    await testDb().query(
      `UPDATE users SET oidc_issuer = $1, oidc_subject = $2 WHERE id = $3`,
      ['https://idp.example.org/realms/markoto', 'opaque-subject-123', u.id]
    )
    const result = await buildExportZip(sys(), u.id)
    const profile = JSON.parse(readEntry(result.bytes, 'profile.json'))
    expect(profile.oidcLinked).toBe(true)
    expect(profile.oidcIssuer).toBe('https://idp.example.org/realms/markoto')
    expect(JSON.stringify(profile)).not.toContain('opaque-subject-123')
  })

  it('exports saved themes with their name and description', async () => {
    const u = await createUser()
    await testDb().query(
      `INSERT INTO themes (theme_id, user_id, name, description, theme) VALUES ($1, $2, $3, $4, $5)`,
      ['th-export-1', u.id, 'Paper', 'Two columns, serif body', JSON.stringify({ page: { size: 'A4' } })]
    )
    const result = await buildExportZip(sys(), u.id)
    const themes = JSON.parse(readEntry(result.bytes, 'themes.json')) as Array<{ themeId: string, name: string, description: string }>
    expect(themes).toHaveLength(1)
    expect(themes[0]).toMatchObject({ themeId: 'th-export-1', name: 'Paper', description: 'Two columns, serif body' })
  })

  it('includes the user\'s linked waitlist sign-up without any token hashes', async () => {
    const u = await createUser()
    await testDb().query(
      `INSERT INTO waitlist_signups (email, locale, consent_version, consent_text_id, user_id, confirm_token_hash, confirm_token_expires_at, unsubscribe_token_hash)
       VALUES ('me@example.com', 'de', 1, 'waitlist.consentLabel', $1, 'confirm-hash-secret', NOW() + interval '7 days', 'unsub-hash-secret')`,
      [u.id]
    )
    const result = await buildExportZip(sys(), u.id)
    const raw = readEntry(result.bytes, 'waitlist.ndjson')
    expect(raw).not.toContain('hash-secret')
    const rows = raw.trim().split('\n').map(l => JSON.parse(l))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      email: 'me@example.com',
      locale: 'de',
      consentVersion: 1,
      consentTextId: 'waitlist.consentLabel',
      confirmedAt: null
    })
    expect(result.counts.waitlistSignups).toBe(1)
  })

  it('includes open workspace invitations received and sent, never token hashes', async () => {
    const admin = await createUser()
    const u = await createUser({ email: 'Me@Example.com' })
    const ws = await createWorkspace(admin.id, { name: 'Their space' })
    const mine = await createWorkspace(u.id, { name: 'My space' })
    await testDb().query(
      `INSERT INTO workspace_invites (invite_id, workspace_id, email, role, invited_by_user_id, token_hash, expires_at)
       VALUES ('inv-received-1', $1, 'me@example.com', 'viewer', $2, 'token-hash-secret', NOW() + interval '7 days'),
              ('inv-sent-1', $3, 'friend@example.com', 'editor', $4, NULL, NOW() + interval '7 days')`,
      [ws.workspaceId, admin.id, mine.workspaceId, u.id]
    )
    const result = await buildExportZip(sys(), u.id)
    const raw = readEntry(result.bytes, 'workspace_invites.json')
    expect(raw).not.toContain('token-hash-secret')
    const parsed = JSON.parse(raw)
    expect(parsed.received).toMatchObject([{ workspaceName: 'Their space', role: 'viewer' }])
    expect(parsed.sent).toMatchObject([{ workspaceId: mine.workspaceId, email: 'friend@example.com', role: 'editor' }])
    expect(result.counts.workspaceInvites).toBe(2)
  })

  it('billing off: a leftover Stripe customer id yields empty billing entries, never an error', async () => {
    vi.stubEnv('NUXT_BILLING_ENABLED', 'false')
    try {
      const u = await createUser()
      await testDb().query(`UPDATE users SET stripe_customer_id = 'cus_leftover' WHERE id = $1`, [u.id])
      const result = await buildExportZip(sys(), u.id)
      expect(readEntry(result.bytes, 'billing/customer.json')).toBe('{}')
      expect(readEntry(result.bytes, 'billing/invoices.ndjson')).toBe('')
      expect(result.counts.invoices).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('includes owned-doc markdown + meta.json files', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id, title: 'My Doc', description: 'A test doc' })

    const result = await buildExportZip(sys(), u.id)
    const names = entryNames(result.bytes)
    expect(names).toContain(`documents/${doc.docId}.md`)
    expect(names).toContain(`documents/${doc.docId}.meta.json`)

    // Without yjs_updates rows the markdown is empty.
    const md = readEntry(result.bytes, `documents/${doc.docId}.md`)
    expect(md).toBe('')

    const meta = JSON.parse(readEntry(result.bytes, `documents/${doc.docId}.meta.json`))
    expect(meta).toMatchObject({
      docId: doc.docId,
      title: 'My Doc',
      description: 'A test doc',
      audience: 'casual',
      language: 'en'
    })

    expect(result.counts.documents).toBe(1)
  })

  it('exports the current text from the Y.js log, starting at its newest snapshot', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    const ydoc = new Y.Doc()
    ydoc.getText('content').insert(0, '# Kept')
    await insertYjsUpdate(doc.docId, Y.encodeStateAsUpdate(ydoc))
    await testDb().query(
      `INSERT INTO yjs_updates (doc_id, kind, data) VALUES ($1, 'snapshot', $2)`,
      [doc.docId, Buffer.from(Y.encodeStateAsUpdate(ydoc))]
    )
    const sv = Y.encodeStateVector(ydoc)
    ydoc.getText('content').insert(6, '\n\nand edited after the snapshot')
    await insertYjsUpdate(doc.docId, Y.encodeStateAsUpdate(ydoc, sv))

    const result = await buildExportZip(sys(), u.id)
    expect(readEntry(result.bytes, `documents/${doc.docId}.md`)).toBe('# Kept\n\nand edited after the snapshot')
  })

  it('writes comments authored by the user as NDJSON', async () => {
    const u = await createUser()
    const other = await createUser()
    const doc = await createDoc({ ownerId: other.id })
    await insertComment({ docId: doc.docId, entryId: 'c1', authorId: u.id, authorName: u.name, body: 'hi' })
    await insertComment({ docId: doc.docId, entryId: 'c2', authorId: u.id, authorName: u.name, body: 'second' })
    await insertComment({ docId: doc.docId, entryId: 'c3', authorId: other.id, authorName: other.name, body: 'reply' })

    const result = await buildExportZip(sys(), u.id)
    const ndjson = readEntry(result.bytes, 'comments.ndjson')
    const lines = ndjson.trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    const parsed = lines.map(l => JSON.parse(l))
    const bodies = parsed.map((r: { body: string }) => r.body).sort()
    expect(bodies).toEqual(['hi', 'second'])
    expect(result.counts.comments).toBe(2)
  })

  it('writes workspace memberships', async () => {
    const u = await createUser()
    const owner = await createUser()
    const ws = await createWorkspace(owner.id, { name: 'Library' })
    await setMemberRole(ws.workspaceId, u.id, 'editor')

    const result = await buildExportZip(sys(), u.id)
    const list = JSON.parse(readEntry(result.bytes, 'workspace_memberships.json'))
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      workspaceId: ws.workspaceId,
      workspaceName: 'Library',
      role: 'editor'
    })
  })

  it('includes audit rows where the user is actor OR scope target', async () => {
    const u = await createUser()
    const other = await createUser()
    // Actor is the user
    await testDb().query(
      `INSERT INTO audit_log (actor_user_id, scope, scope_id, action) VALUES ($1, 'doc', 'd1', 'doc.deleted')`,
      [u.id]
    )
    // Scope target is the user (e.g. account.delete_requested)
    await testDb().query(
      `INSERT INTO audit_log (actor_user_id, scope, scope_id, action) VALUES (NULL, 'user', $1, 'account.delete_requested')`,
      [String(u.id)]
    )
    // Unrelated to the user — must be excluded
    await testDb().query(
      `INSERT INTO audit_log (actor_user_id, scope, scope_id, action) VALUES ($1, 'doc', 'd2', 'doc.deleted')`,
      [other.id]
    )

    const result = await buildExportZip(sys(), u.id)
    const ndjson = readEntry(result.bytes, 'audit.ndjson')
    const lines = ndjson.trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    const actions = lines.map(l => JSON.parse(l)).map(r => r.action).sort()
    expect(actions).toEqual(['account.delete_requested', 'doc.deleted'])
  })

  it('emits empty billing files when no Stripe customer is set', async () => {
    const u = await createUser()
    const result = await buildExportZip(sys(), u.id)
    const customer = readEntry(result.bytes, 'billing/customer.json')
    expect(customer).toBe('{}')
    expect(readEntry(result.bytes, 'billing/invoices.ndjson')).toBe('')
    expect(result.counts.invoices).toBe(0)
  })
})
