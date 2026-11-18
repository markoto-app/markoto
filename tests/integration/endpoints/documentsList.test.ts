import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient, type TestClient } from '../setup/client'
import { createUser, createWorkspace, setMemberRole } from '../setup/fixtures'

// The explorer's paginated document lists: sort orders, folder filter,
// cursor paging over a few hundred documents with tied timestamps, the
// `q` search mode, and the personal list.

interface Page {
  items: Array<{ docId: string, title: string, folderId: string | null, updatedAt: string, isOwner: boolean, snippet?: string }>
  total: number
  nextCursor: string | null
}

async function page(c: TestClient, path: string): Promise<Page> {
  const res = await c.get(path)
  expect(res.status, await res.clone().text()).toBe(200)
  return await res.json() as Page
}

async function allPages(c: TestClient, base: string): Promise<Page['items']> {
  const out: Page['items'] = []
  let cursor: string | null = null
  for (let i = 0; i < 50; i++) {
    const p: Page = await page(c, `${base}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    out.push(...p.items)
    cursor = p.nextCursor
    if (!cursor) break
  }
  return out
}

/** `n` documents in one statement; every tenth shares one timestamp so the order has ties. */
async function seedDocs(n: number, ownerId: number, workspaceId: string | null, folderId: string | null = null): Promise<void> {
  await testDb().query(`
    INSERT INTO documents (doc_id, owner_id, workspace_id, folder_id, access_mode, title, updated_at, created_at)
    SELECT 'seed' || lpad(g::text, 4, '0') || $4, $1, $2, $3, 'private', 'Doc ' || lpad(((g * 37) % $5)::text, 4, '0'),
      CASE WHEN g % 10 = 0 THEN timestamptz '2026-03-01 12:00:00.000001+00' ELSE timestamptz '2026-01-01' + g * interval '1 minute' END,
      timestamptz '2026-01-01' + g * interval '1 second'
    FROM generate_series(1, $5) g
  `, [ownerId, workspaceId, folderId, workspaceId ? 'w' : 'p', n])
}

describe('GET /api/workspaces/:wsId/documents', () => {
  beforeEach(resetDb)

  it('pages through 250 documents without repeats or gaps, in every sort', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await seedDocs(250, admin.id, ws.workspaceId)
    const a = await loggedInClient(admin.id)

    for (const query of ['sort=updated', 'sort=updated&dir=asc', 'sort=title', 'sort=title&dir=desc', 'sort=created', 'sort=active']) {
      const items = await allPages(a, `/api/workspaces/${ws.workspaceId}/documents?folder=all&limit=37&${query}`)
      expect(items, query).toHaveLength(250)
      expect(new Set(items.map(i => i.docId)).size, query).toBe(250)
    }
    const byUpdated = await allPages(a, `/api/workspaces/${ws.workspaceId}/documents?folder=all&limit=50&sort=updated`)
    const times = byUpdated.map(i => Date.parse(i.updatedAt))
    expect(times).toEqual(times.toSorted((x, y) => y - x))
    const byTitle = await allPages(a, `/api/workspaces/${ws.workspaceId}/documents?folder=all&limit=50&sort=title`)
    const titles = byTitle.map(i => i.title.toLowerCase())
    expect(titles).toEqual(titles.toSorted())

    const first = await page(a, `/api/workspaces/${ws.workspaceId}/documents?folder=all&limit=10`)
    expect(first.total).toBe(250)
    expect(first.items).toHaveLength(10)
  })

  it('filters by folder and refuses a cursor it did not make', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const a = await loggedInClient(admin.id)
    const res = await a.post(`/api/workspaces/${ws.workspaceId}/folders`, { name: 'F' })
    const folderId = ((await res.json()) as { folder: { folderId: string } }).folder.folderId
    await seedDocs(3, admin.id, ws.workspaceId, folderId)
    await testDb().query(`INSERT INTO documents (doc_id, owner_id, workspace_id, title) VALUES ('rootdoc01', $1, $2, 'Root one')`, [admin.id, ws.workspaceId])

    expect((await page(a, `/api/workspaces/${ws.workspaceId}/documents`)).items.map(i => i.docId)).toEqual(['rootdoc01'])
    const inFolder = await page(a, `/api/workspaces/${ws.workspaceId}/documents?folder=${folderId}`)
    expect(inFolder.total).toBe(3)
    expect(inFolder.items.every(i => i.folderId === folderId)).toBe(true)
    expect((await page(a, `/api/workspaces/${ws.workspaceId}/documents?folder=all`)).total).toBe(4)
    expect((await a.get(`/api/workspaces/${ws.workspaceId}/documents?cursor=not-a-cursor`)).status).toBe(400)
  })

  it('answers members only; a viewer sees every document of the workspace', async () => {
    const admin = await createUser()
    const viewer = await createUser()
    const outsider = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    await seedDocs(5, admin.id, ws.workspaceId)
    const v = await loggedInClient(viewer.id)
    const p = await page(v, `/api/workspaces/${ws.workspaceId}/documents?folder=all`)
    expect(p.total).toBe(5)
    expect(p.items.every(i => !i.isOwner)).toBe(true)
    expect((await (await loggedInClient(outsider.id)).get(`/api/workspaces/${ws.workspaceId}/documents`)).status).toBe(404)
  })

  it('switches to a ranked search with q', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const a = await loggedInClient(admin.id)
    await testDb().query(`
      INSERT INTO documents (doc_id, owner_id, workspace_id, title) VALUES
        ('qdoc00001', $1, $2, 'Budget 2027'), ('qdoc00002', $1, $2, 'Minutes'), ('qdoc00003', $1, $2, 'Other')`, [admin.id, ws.workspaceId])
    await testDb().query(`INSERT INTO document_search (doc_id, title, body, yjs_id) VALUES ('qdoc00002', 'Minutes', 'we agreed on the budget for travel', 1)`)
    const hits = await page(a, `/api/workspaces/${ws.workspaceId}/documents?folder=all&q=budg`)
    expect(hits.items.map(i => i.docId)).toEqual(['qdoc00001', 'qdoc00002'])
    expect(hits.items[1]?.snippet).toContain('budget')
  })
})

describe('GET /api/user/personal-documents', () => {
  beforeEach(resetDb)

  it('lists only the caller\'s documents outside any workspace', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const ws = await createWorkspace(alice.id)
    await seedDocs(4, alice.id, null)
    await seedDocs(2, alice.id, ws.workspaceId)
    await testDb().query(`INSERT INTO documents (doc_id, owner_id, title) VALUES ('bobdoc001', $1, 'Bob')`, [bob.id])
    const a = await loggedInClient(alice.id)
    const items = await allPages(a, '/api/user/personal-documents?folder=all&limit=3')
    expect(items).toHaveLength(4)
    expect(items.every(i => i.isOwner)).toBe(true)
  })
})
