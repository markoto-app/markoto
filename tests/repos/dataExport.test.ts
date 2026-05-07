import { describe, it, expect, beforeEach, vi } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { resetDb, testDb } from '../integration/setup/db'
import {
  createDoc,
  createUser,
  createWorkspace,
  setMemberRole
} from '../integration/setup/fixtures'

// Stripe stub — we don't want the export builder hitting the network.
vi.mock('../../server/utils/stripeClient', () => ({
  useStripeClient: () => null
}))

const { buildExportZip } = await import('../../server/utils/dataExport')

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
    await expect(buildExportZip(99_999_999)).rejects.toThrow(/not found/)
  })

  it('emits the canonical layout for a brand-new user with no data', async () => {
    const u = await createUser()
    const result = await buildExportZip(u.id)
    expect(result.bytes.byteLength).toBeGreaterThan(0)

    const names = entryNames(result.bytes)
    expect(names).toEqual([
      'README.txt',
      'activity.ndjson',
      'ai/messages.ndjson',
      'ai/sessions.ndjson',
      'audit.ndjson',
      'billing/customer.json',
      'billing/invoices.ndjson',
      'comments.ndjson',
      'consent.ndjson',
      'profile.json',
      'themes.json',
      'workspace_memberships.json'
    ].sort())

    // Empty data files exist but contain zero rows.
    expect(readEntry(result.bytes, 'comments.ndjson')).toBe('')
    expect(readEntry(result.bytes, 'consent.ndjson')).toBe('')
    expect(readEntry(result.bytes, 'workspace_memberships.json')).toBe('[]')
    expect(readEntry(result.bytes, 'themes.json')).toBe('[]')

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
  })

  it('includes owned-doc markdown + meta.json files', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id, title: 'My Doc', description: 'A test doc' })

    const result = await buildExportZip(u.id)
    const names = entryNames(result.bytes)
    expect(names).toContain(`documents/${doc.docId}.md`)
    expect(names).toContain(`documents/${doc.docId}.meta.json`)

    // Without yjs_documents rows the markdown is empty (the y-postgresql
    // table is created lazily by the sync server). That's fine.
    const md = readEntry(result.bytes, `documents/${doc.docId}.md`)
    expect(typeof md).toBe('string')

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

  it('writes comments authored by the user as NDJSON', async () => {
    const u = await createUser()
    const other = await createUser()
    const doc = await createDoc({ ownerId: other.id })
    await insertComment({ docId: doc.docId, entryId: 'c1', authorId: u.id, authorName: u.name, body: 'hi' })
    await insertComment({ docId: doc.docId, entryId: 'c2', authorId: u.id, authorName: u.name, body: 'second' })
    await insertComment({ docId: doc.docId, entryId: 'c3', authorId: other.id, authorName: other.name, body: 'reply' })

    const result = await buildExportZip(u.id)
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

    const result = await buildExportZip(u.id)
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

    const result = await buildExportZip(u.id)
    const ndjson = readEntry(result.bytes, 'audit.ndjson')
    const lines = ndjson.trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    const actions = lines.map(l => JSON.parse(l)).map(r => r.action).sort()
    expect(actions).toEqual(['account.delete_requested', 'doc.deleted'])
  })

  it('emits empty billing files when no Stripe customer is set', async () => {
    const u = await createUser()
    const result = await buildExportZip(u.id)
    const customer = readEntry(result.bytes, 'billing/customer.json')
    expect(customer).toBe('{}')
    expect(readEntry(result.bytes, 'billing/invoices.ndjson')).toBe('')
    expect(result.counts.invoices).toBe(0)
  })
})
