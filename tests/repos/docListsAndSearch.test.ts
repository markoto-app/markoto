import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../integration/setup/fixtures'
import { listScopeDocs, type DocListQuery } from '../../server/repos/documents'
import { createFolder, moveDocToFolder, type FolderScope } from '../../server/repos/folders'
import { searchDocuments, upsertDocumentSearch } from '../../server/repos/documentSearch'
import { __mintWorkspaceAccess, __userActor } from '../../server/repos/proofs/testing'
import { asUser, docAs } from '../helpers/access'
import { prefixTsQuery } from '../../shared/utils/documents/searchQuery'
import type { DocListSort, SortDirection } from '../../shared/api/explorer'

// The explorer's document pages (keyset pagination over a sort column with
// ties) and the search over `document_search` (newer text wins, ranking,
// and only documents the caller can reach).

function wsMember(workspaceId: string, userId: number) {
  return __mintWorkspaceAccess(__userActor(userId), workspaceId, 'viewer', 'member')
}

/** Every page of a listing, following the keyset position of the last row. */
async function allPages(scope: FolderScope, q: Omit<DocListQuery, 'after' | 'limit'>, pageSize: number): Promise<string[]> {
  const ids: string[] = []
  let after: DocListQuery['after']
  for (let i = 0; i < 100; i++) {
    const { rows } = await listScopeDocs(scope, { ...q, after, limit: pageSize })
    ids.push(...rows.map(r => r.docId))
    const last = rows.at(-1)
    if (rows.length < pageSize || !last) break
    after = { key: last.sortKey, docId: last.docId }
  }
  return ids
}

describe('listScopeDocs', () => {
  beforeEach(resetDb)

  it('pages through ties on every sort without skipping or repeating a row', async () => {
    const alice = await createUser()
    const ws = await createWorkspace(alice.id)
    const scope = wsMember(ws.workspaceId, alice.id)
    const ids: string[] = []
    for (let i = 0; i < 23; i++) {
      // Three titles and one timestamp shared by all: the order is decided by the id.
      const d = await createDoc({ ownerId: alice.id, workspaceId: ws.workspaceId, title: ['Beta', 'alpha', 'Gamma'][i % 3] })
      ids.push(d.docId)
    }
    await testDb().query(`UPDATE documents SET updated_at = '2026-01-01T10:00:00.123456Z', created_at = '2026-01-01T10:00:00.123456Z' WHERE workspace_id = $1`, [ws.workspaceId])
    // A few distinct timestamps (microseconds apart) among the ties.
    await testDb().query(`UPDATE documents SET updated_at = updated_at + interval '1 microsecond' WHERE doc_id = ANY($1)`, [ids.slice(0, 4)])

    const sorts: Array<[DocListSort, SortDirection]> = [['updated', 'desc'], ['updated', 'asc'], ['title', 'asc'], ['title', 'desc'], ['created', 'desc']]
    for (const [sort, dir] of sorts) {
      const paged = await allPages(scope, { folder: 'all', sort, dir }, 5)
      const whole = (await listScopeDocs(scope, { folder: 'all', sort, dir, limit: 100 })).rows.map(r => r.docId)
      expect(paged, `${sort} ${dir}`).toEqual(whole)
      expect(new Set(paged).size).toBe(23)
    }
    const byTitle = (await listScopeDocs(scope, { folder: 'all', sort: 'title', dir: 'asc', limit: 100 })).rows.map(r => r.title.toLowerCase())
    expect(byTitle).toEqual(byTitle.toSorted())
    const updated = (await listScopeDocs(scope, { folder: 'all', sort: 'updated', dir: 'desc', limit: 4 })).rows.map(r => r.docId)
    expect(updated.toSorted()).toEqual(ids.slice(0, 4).toSorted())
  })

  it('filters by folder, root and owner, and counts all matches', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const ws = await createWorkspace(alice.id)
    await setMemberRole(ws.workspaceId, bob.id, 'editor')
    const scope = wsMember(ws.workspaceId, alice.id)
    await createFolder(__mintWorkspaceAccess(__userActor(alice.id), ws.workspaceId, 'admin', 'editor'), { folderId: 'f', name: 'F', parentId: null })
    const inFolder = await createDoc({ ownerId: alice.id, workspaceId: ws.workspaceId })
    const atRoot = await createDoc({ ownerId: bob.id, workspaceId: ws.workspaceId })
    await createDoc({ ownerId: alice.id }) // personal: not in the workspace listing
    await moveDocToFolder(docAs(inFolder.docId), 'f')

    const root = await listScopeDocs(scope, { folder: null, sort: 'updated', dir: 'desc', limit: 10 })
    expect(root.rows.map(r => r.docId)).toEqual([atRoot.docId])
    expect(root.rows[0]).toMatchObject({ isOwner: false, ownerName: bob.name })
    expect((await listScopeDocs(scope, { folder: 'f', sort: 'updated', dir: 'desc', limit: 10 })).rows.map(r => r.docId)).toEqual([inFolder.docId])
    const all = await listScopeDocs(scope, { folder: 'all', sort: 'updated', dir: 'desc', limit: 1 })
    expect(all.rows).toHaveLength(1)
    expect(all.total).toBe(2)
    expect((await listScopeDocs(scope, { folder: 'all', ownerId: bob.id, sort: 'updated', dir: 'desc', limit: 10 })).rows.map(r => r.docId)).toEqual([atRoot.docId])
    expect((await listScopeDocs(asUser(alice.id), { folder: 'all', sort: 'updated', dir: 'desc', limit: 10 })).total).toBe(1)
    expect(await listScopeDocs(scope, { folder: 'all', docIds: [], sort: 'updated', dir: 'desc', limit: 10 })).toEqual({ rows: [], total: 0 })
  })
})

describe('document search', () => {
  beforeEach(resetDb)

  async function index(docId: string, title: string, body: string, yjsId: number | null) {
    await upsertDocumentSearch(docAs(docId), { title, body, yjsId, wordCount: body.split(/\s+/).length, sizeBytes: body.length })
  }

  async function searchRow(docId: string) {
    return (await testDb().query<{ title: string, body: string, yjs_id: string | null }>('SELECT title, body, yjs_id FROM document_search WHERE doc_id = $1', [docId])).rows[0]
  }

  it('keeps the text of the newest Y.js row and updates the document row', async () => {
    const alice = await createUser()
    const doc = await createDoc({ ownerId: alice.id, title: 'Old' })
    await index(doc.docId, 'Second', 'newer text', 20)
    await index(doc.docId, 'First', 'older text', 10)
    expect(await searchRow(doc.docId)).toMatchObject({ title: 'Second', body: 'newer text' })
    await index(doc.docId, 'Third', 'newest text', 30)
    expect(await searchRow(doc.docId)).toMatchObject({ title: 'Third', body: 'newest text' })
    const row = (await testDb().query<{ title: string, word_count: number }>('SELECT title, word_count FROM documents WHERE doc_id = $1', [doc.docId])).rows[0]
    expect(row).toEqual({ title: 'Third', word_count: 2 })
  })

  it('never indexes an anonymous document', async () => {
    const doc = await createDoc({ ownerId: null })
    await index(doc.docId, 'Anon', 'secret words', 1)
    expect(await searchRow(doc.docId)).toBeUndefined()
  })

  it('ranks title matches first and finds body words by prefix, with a snippet', async () => {
    const alice = await createUser()
    const titled = await createDoc({ ownerId: alice.id, title: 'Quarterly planning' })
    const bodied = await createDoc({ ownerId: alice.id, title: 'Notes' })
    await index(titled.docId, 'Quarterly planning', 'nothing here', 1)
    await index(bodied.docId, 'Notes', 'we discussed the planning offsite in Zurich', 2)
    const hits = await searchDocuments(asUser(alice.id), { workspaces: [], personal: true, shared: false }, { tsQuery: prefixTsQuery('plann'), raw: 'plann', limit: 10, offset: 0 })
    expect(hits.map(h => h.docId)).toEqual([titled.docId, bodied.docId])
    expect(hits[1]?.snippet).toContain('planning')
    expect(hits[0]?.snippet).toBe('')
  })

  it('finds an unindexed document by its title', async () => {
    const alice = await createUser()
    const doc = await createDoc({ ownerId: alice.id, title: 'Roadmap draft' })
    const hits = await searchDocuments(asUser(alice.id), { workspaces: [], personal: true, shared: false }, { tsQuery: prefixTsQuery('roadmap'), raw: 'roadmap', limit: 10, offset: 0 })
    expect(hits.map(h => h.docId)).toEqual([doc.docId])
  })

  it('returns only documents the caller can reach', async () => {
    const owner = await createUser()
    const member = await createUser()
    const outsider = await createUser()
    const guest = await createUser()
    const ws = await createWorkspace(owner.id)
    await setMemberRole(ws.workspaceId, member.id, 'viewer')
    await setMemberRole(ws.workspaceId, guest.id, 'guest')
    const wsDoc = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, title: 'Workspace doc' })
    const sharedDoc = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, title: 'Shared doc' })
    const personal = await createDoc({ ownerId: owner.id, title: 'Personal doc' })
    for (const d of [wsDoc, sharedDoc, personal]) await index(d.docId, '', 'pineapple', 1)
    await testDb().query(`INSERT INTO document_shares (doc_id, user_id, access, granted_by_user_id) VALUES ($1, $2, 'view', $3)`, [sharedDoc.docId, guest.id, owner.id])

    const q = { tsQuery: prefixTsQuery('pineapple'), raw: 'pineapple', limit: 10, offset: 0 }
    const ids = async (userId: number, workspaces: Array<ReturnType<typeof wsMember>>) =>
      (await searchDocuments(asUser(userId), { workspaces, personal: true, shared: true }, q)).map(h => h.docId).toSorted()

    expect(await ids(owner.id, [wsMember(ws.workspaceId, owner.id)])).toEqual([wsDoc.docId, sharedDoc.docId, personal.docId].toSorted())
    expect(await ids(member.id, [wsMember(ws.workspaceId, member.id)])).toEqual([wsDoc.docId, sharedDoc.docId].toSorted())
    expect(await ids(outsider.id, [])).toEqual([])
    expect(await ids(guest.id, [])).toEqual([sharedDoc.docId])
    // A workspace proof held by somebody else is ignored.
    expect(await ids(outsider.id, [wsMember(ws.workspaceId, member.id)])).toEqual([])
  })
})
