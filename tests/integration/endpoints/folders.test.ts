import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from '../setup/db'
import { loggedInClient, type TestClient } from '../setup/client'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../setup/fixtures'

// Folder routes: who may read and change a workspace's folders (every
// member reads, editors and admins write, guests and outsiders see
// nothing), personal folders for their owner only, and the tree rules
// (no cycles, unique names) answered with their error codes.

async function code(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { data?: { code?: string } }).data?.code
}

async function createWsFolder(c: TestClient, wsId: string, name: string, parentId: string | null = null): Promise<string> {
  const res = await c.post(`/api/workspaces/${wsId}/folders`, { name, parentId })
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { folder: { folderId: string } }).folder.folderId
}

describe('workspace folders', () => {
  beforeEach(resetDb)

  it('lets admins and editors create, viewers only read, guests and outsiders nothing', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const viewer = await createUser()
    const guest = await createUser()
    const outsider = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    await setMemberRole(ws.workspaceId, guest.id, 'guest')
    const [a, e, v, g, o] = await Promise.all([admin, editor, viewer, guest, outsider].map(u => loggedInClient(u.id)))

    const top = await createWsFolder(a!, ws.workspaceId, 'Projects')
    await createWsFolder(e!, ws.workspaceId, 'Drafts', top)
    const denied = await v!.post(`/api/workspaces/${ws.workspaceId}/folders`, { name: 'Nope' })
    expect(denied.status).toBe(403)

    const list = await v!.get(`/api/workspaces/${ws.workspaceId}/folders`)
    expect(list.status).toBe(200)
    const folders = ((await list.json()) as { folders: Array<{ name: string, parentId: string | null }> }).folders
    expect(folders.map(f => f.name).toSorted()).toEqual(['Drafts', 'Projects'])

    for (const c of [g!, o!]) {
      expect((await c.get(`/api/workspaces/${ws.workspaceId}/folders`)).status).toBe(404)
      expect((await c.post(`/api/workspaces/${ws.workspaceId}/folders`, { name: 'X' })).status).toBe(404)
      const path = await c.get(`/api/folders/${top}/path`)
      expect(path.status).toBe(404)
      expect(await code(path)).toBe('folder/not-found')
      expect((await c.patch(`/api/folders/${top}`, { name: 'Hijack' })).status).toBe(404)
      expect((await c.delete(`/api/folders/${top}`)).status).toBe(404)
    }
    // A viewer can read the breadcrumb but not rename.
    expect((await v!.get(`/api/folders/${top}/path`)).status).toBe(200)
    const rename = await v!.patch(`/api/folders/${top}`, { name: 'Renamed' })
    expect(rename.status).toBe(404)
    expect(await code(rename)).toBe('folder/not-found')
  })

  it('renames and moves; refuses a cycle, a duplicate name and a stale folder', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const a = await loggedInClient(admin.id)
    const p = await createWsFolder(a, ws.workspaceId, 'Parent')
    const c = await createWsFolder(a, ws.workspaceId, 'Child', p)
    const g = await createWsFolder(a, ws.workspaceId, 'Grandchild', c)
    await createWsFolder(a, ws.workspaceId, 'Taken')

    const cycle = await a.patch(`/api/folders/${p}`, { parentId: g })
    expect(cycle.status).toBe(409)
    expect(await code(cycle)).toBe('folder/cycle')

    const dup = await a.patch(`/api/folders/${c}`, { name: 'taken', parentId: null })
    expect(dup.status).toBe(409)
    expect(await code(dup)).toBe('folder/name-taken')
    const dupCreate = await a.post(`/api/workspaces/${ws.workspaceId}/folders`, { name: 'TAKEN' })
    expect(await code(dupCreate)).toBe('folder/name-taken')

    const moved = await a.patch(`/api/folders/${g}`, { name: 'Moved', parentId: null })
    expect(moved.status).toBe(200)
    expect(((await moved.json()) as { folder: { name: string, parentId: string | null } }).folder).toMatchObject({ name: 'Moved', parentId: null })

    const path = (await (await a.get(`/api/folders/${c}/path`)).json()) as { workspaceId: string, path: Array<{ name: string }> }
    expect(path).toMatchObject({ workspaceId: ws.workspaceId, path: [{ name: 'Parent' }, { name: 'Child' }] })

    expect((await a.delete(`/api/folders/${c}`)).status).toBe(200)
    for (const res of [await a.patch(`/api/folders/${c}`, { name: 'Again' }), await a.get(`/api/folders/${c}/path`), await a.get(`/api/folders/${c}/delete-preview`)]) {
      expect(res.status).toBe(404)
      expect(await code(res)).toBe('folder/not-found')
    }
    const list = await a.get(`/api/workspaces/${ws.workspaceId}/documents?folder=${c}`)
    expect(await code(list)).toBe('folder/not-found')
  })

  it('refuses a folder name with a slash and an empty name', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const a = await loggedInClient(admin.id)
    expect((await a.post(`/api/workspaces/${ws.workspaceId}/folders`, { name: 'a/b' })).status).toBe(400)
    expect((await a.post(`/api/workspaces/${ws.workspaceId}/folders`, { name: '   ' })).status).toBe(400)
  })

  it('files a document only into a folder of its own workspace', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const other = await createWorkspace(admin.id)
    const a = await loggedInClient(admin.id)
    const here = await createWsFolder(a, ws.workspaceId, 'Here')
    const there = await createWsFolder(a, other.workspaceId, 'There')
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    const wrong = await a.patch(`/api/docs/${doc.docId}/folder`, { folderId: there })
    expect(wrong.status).toBe(404)
    expect(await code(wrong)).toBe('folder/not-found')
    expect((await a.patch(`/api/docs/${doc.docId}/folder`, { folderId: here })).status).toBe(200)
    const page = (await (await a.get(`/api/workspaces/${ws.workspaceId}/documents?folder=${here}`)).json()) as { items: Array<{ docId: string }> }
    expect(page.items.map(i => i.docId)).toEqual([doc.docId])
  })
})

describe('personal folders', () => {
  beforeEach(resetDb)

  it('belong to their owner only', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const a = await loggedInClient(alice.id)
    const b = await loggedInClient(bob.id)
    const res = await a.post('/api/user/folders', { name: 'Private' })
    expect(res.status).toBe(200)
    const folderId = ((await res.json()) as { folder: { folderId: string } }).folder.folderId
    const mine = (await (await a.get('/api/user/folders')).json()) as { folders: Array<{ folderId: string }> }
    expect(mine.folders.map(f => f.folderId)).toEqual([folderId])
    expect(((await (await b.get('/api/user/folders')).json()) as { folders: unknown[] }).folders).toEqual([])
    expect((await b.get(`/api/folders/${folderId}/path`)).status).toBe(404)
    expect((await b.patch(`/api/folders/${folderId}`, { name: 'Mine now' })).status).toBe(404)
    expect((await b.delete(`/api/folders/${folderId}`)).status).toBe(404)

    // Bob can't file his document into Alice's folder.
    const bobDoc = await createDoc({ ownerId: bob.id })
    expect((await b.patch(`/api/docs/${bobDoc.docId}/folder`, { folderId })).status).toBe(404)
  })
})
