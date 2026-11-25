import { describe, it, expect, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import { resetDb, testDb } from '../integration/setup/db'
import { createDoc, createUser, createWorkspace } from '../integration/setup/fixtures'
import { asUser } from '../helpers/access'
import { adoptAnonymousDocs } from '../../server/repos/documents'
import { ADOPT_MAX_PER_SIGN_IN, adoptBrowserDocuments } from '../../server/utils/documents/adoptAnonymous'
import { hashAnonCreatorKey } from '../../server/utils/auth/anonCreator'

// "Sign in to keep your documents": the anonymous documents a browser
// created (creator-key hash) become the account's after a sign-in there.

const KEY = 'k'.repeat(43)
const OTHER_KEY = 'o'.repeat(43)
const DAY = 24 * 60 * 60 * 1000

async function anonDoc(docId: string, key: string | null, extra: { workspaceId?: string, lastActive?: Date, accessMode?: 'open-edit' | 'open-view' } = {}): Promise<void> {
  await createDoc({ docId, workspaceId: extra.workspaceId, accessMode: extra.accessMode })
  await testDb().query(
    `UPDATE documents SET anon_creator_key_hash = $2, anon_terms_version = 3, anon_terms_accepted_at = now(), last_active = $3 WHERE doc_id = $1`,
    [docId, key === null ? null : hashAnonCreatorKey(key), extra.lastActive ?? new Date()]
  )
}

async function row(docId: string) {
  return (await testDb().query<{ owner_id: number | null, anon_creator_key_hash: string | null, anon_terms_version: number | null, anon_terms_accepted_at: Date | null, access_mode: string }>(
    'SELECT owner_id, anon_creator_key_hash, anon_terms_version, anon_terms_accepted_at, access_mode FROM documents WHERE doc_id = $1',
    [docId]
  )).rows[0]
}

function eventWithCookie(cookie: string | null): H3Event {
  const headers: Record<string, string> = { host: 'markoto.test' }
  if (cookie) headers.cookie = cookie
  return {
    path: '/api/docs/adopt',
    node: { req: { url: '/api/docs/adopt', headers, socket: { remoteAddress: '203.0.113.7' }, connection: { remoteAddress: '203.0.113.7' } }, res: {} },
    context: {}
  } as unknown as H3Event
}

describe('adoptAnonymousDocs', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('hands this browser\'s anonymous documents to the account, keeping their access mode', async () => {
    const user = await createUser()
    await anonDoc('mine-edit', KEY)
    await anonDoc('mine-view', KEY, { accessMode: 'open-view' })
    await anonDoc('other-browser', OTHER_KEY)
    await anonDoc('no-key', null)

    const adopted = await adoptAnonymousDocs(asUser(user.id), hashAnonCreatorKey(KEY), { limit: 50, activeSince: null })
    expect(adopted.map(d => d.docId).sort()).toEqual(['mine-edit', 'mine-view'])
    expect(adopted.every(d => d.anonTermsVersion === 3)).toBe(true)

    expect(await row('mine-edit')).toMatchObject({ owner_id: user.id, anon_creator_key_hash: null, anon_terms_version: null, anon_terms_accepted_at: null, access_mode: 'open-edit' })
    expect(await row('mine-view')).toMatchObject({ owner_id: user.id, access_mode: 'open-view' })
    expect(await row('other-browser')).toMatchObject({ owner_id: null })
    expect(await row('no-key')).toMatchObject({ owner_id: null })
  })

  it('is idempotent and never takes an owned or workspace document', async () => {
    const user = await createUser()
    const someone = await createUser()
    const ws = await createWorkspace(someone.id)
    await anonDoc('in-workspace', KEY, { workspaceId: ws.workspaceId })
    await anonDoc('taken', KEY)
    await testDb().query('UPDATE documents SET owner_id = $1 WHERE doc_id = $2', [someone.id, 'taken'])
    await anonDoc('mine', KEY)

    const first = await adoptAnonymousDocs(asUser(user.id), hashAnonCreatorKey(KEY), { limit: 50, activeSince: null })
    expect(first.map(d => d.docId)).toEqual(['mine'])
    const again = await adoptAnonymousDocs(asUser(user.id), hashAnonCreatorKey(KEY), { limit: 50, activeSince: null })
    expect(again).toEqual([])
    expect(await row('taken')).toMatchObject({ owner_id: someone.id })
    expect(await row('in-workspace')).toMatchObject({ owner_id: null })
  })

  it('takes the newest first, at most `limit`, and skips documents past the inactivity limit', async () => {
    const user = await createUser()
    const now = Date.now()
    await anonDoc('old', KEY, { lastActive: new Date(now - 40 * DAY) })
    await anonDoc('newer', KEY, { lastActive: new Date(now - DAY) })
    await anonDoc('newest', KEY, { lastActive: new Date(now) })
    const adopted = await adoptAnonymousDocs(asUser(user.id), hashAnonCreatorKey(KEY), { limit: 1, activeSince: new Date(now - 30 * DAY) })
    expect(adopted.map(d => d.docId)).toEqual(['newest'])
    const rest = await adoptAnonymousDocs(asUser(user.id), hashAnonCreatorKey(KEY), { limit: 10, activeSince: new Date(now - 30 * DAY) })
    expect(rest.map(d => d.docId)).toEqual(['newer'])
    expect(await row('old')).toMatchObject({ owner_id: null })
  })
})

describe('adoptBrowserDocuments', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('reads the creator-key cookie, audits each document and caps the batch', async () => {
    const user = await createUser()
    await anonDoc('doc-a', KEY)
    await anonDoc('doc-b', KEY)

    expect(await adoptBrowserDocuments(eventWithCookie(null), asUser(user.id))).toEqual({ adopted: 0 })
    expect(await adoptBrowserDocuments(eventWithCookie('markoto-anon-creator=not-a-key'), asUser(user.id))).toEqual({ adopted: 0 })

    const res = await adoptBrowserDocuments(eventWithCookie(`markoto-anon-creator=${KEY}`), asUser(user.id))
    expect(res).toEqual({ adopted: 2 })
    const audit = await testDb().query<{ scope_id: string, actor_user_id: number, after: unknown, metadata: unknown }>(
      `SELECT scope_id, actor_user_id, after, metadata FROM audit_log WHERE action = 'doc.adopted' ORDER BY scope_id`
    )
    expect(audit.rows).toEqual([
      expect.objectContaining({ scope_id: 'doc-a', actor_user_id: user.id, after: { ownerId: user.id, accessMode: 'open-edit' }, metadata: { anonTermsVersion: 3 } }),
      expect.objectContaining({ scope_id: 'doc-b', actor_user_id: user.id })
    ])
    // Now searchable for the owner (anonymous documents are never indexed).
    const indexed = await testDb().query('SELECT doc_id FROM document_search WHERE doc_id = ANY($1)', [['doc-a', 'doc-b']])
    expect(indexed.rows).toHaveLength(2)

    expect(await adoptBrowserDocuments(eventWithCookie(`markoto-anon-creator=${KEY}`), asUser(user.id))).toEqual({ adopted: 0 })
    expect(ADOPT_MAX_PER_SIGN_IN).toBe(50)
  })
})
