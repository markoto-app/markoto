import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient, type TestClient } from '../setup/client'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../setup/fixtures'

// Actions on many explorer items at once: each item decided like the
// single-item route (partial success), one audit row per document, folder
// delete refused as a whole unless every document below may be deleted,
// and the explorer change counter moving with every change.

interface BulkAnswer { results: Array<{ id: string, kind: string, ok: boolean, code?: string }>, ok: number, failed: number }

async function code(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { data?: { code?: string } }).data?.code
}

async function folder(c: TestClient, wsId: string, name: string, parentId: string | null = null): Promise<string> {
  const res = await c.post(`/api/workspaces/${wsId}/folders`, { name, parentId })
  expect(res.status).toBe(200)
  return ((await res.json()) as { folder: { folderId: string } }).folder.folderId
}

async function version(c: TestClient, wsId: string): Promise<number> {
  return ((await (await c.get(`/api/workspaces/${wsId}/version`)).json()) as { version: number }).version
}

async function exists(docId: string): Promise<boolean> {
  return ((await testDb().query('SELECT 1 FROM documents WHERE doc_id = $1', [docId])).rowCount ?? 0) > 0
}

describe('POST /api/documents/bulk', () => {
  beforeEach(resetDb)

  it('deletes what the caller may delete, refuses the rest, audits each', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const ws = await createWorkspace(bob.id)
    await setMemberRole(ws.workspaceId, alice.id, 'editor')
    const own1 = await createDoc({ ownerId: alice.id, workspaceId: ws.workspaceId })
    const own2 = await createDoc({ ownerId: alice.id })
    const bobs = await createDoc({ ownerId: bob.id, workspaceId: ws.workspaceId })
    const stranger = await createDoc({ ownerId: bob.id })
    const a = await loggedInClient(alice.id)

    const v0 = await version(a, ws.workspaceId)
    const res = await a.post('/api/documents/bulk', { action: 'delete', docIds: [own1.docId, own2.docId, bobs.docId, stranger.docId, 'missingdoc'] })
    expect(res.status, await res.clone().text()).toBe(200)
    const body = await res.json() as BulkAnswer
    expect(body).toMatchObject({ ok: 2, failed: 3 })
    const byId = new Map(body.results.map(r => [r.id, r]))
    expect(byId.get(own1.docId)?.ok).toBe(true)
    expect(byId.get(own2.docId)?.ok).toBe(true)
    expect(byId.get(bobs.docId)).toMatchObject({ ok: false, code: 'docs/delete-forbidden' })
    expect(byId.get(stranger.docId)?.ok).toBe(false)
    expect(byId.get('missingdoc')?.ok).toBe(false)

    expect(await exists(own1.docId)).toBe(false)
    expect(await exists(bobs.docId)).toBe(true)
    expect(await exists(stranger.docId)).toBe(true)
    const audit = (await testDb().query<{ scope_id: string, metadata: { reason: string } }>(`SELECT scope_id, metadata FROM audit_log WHERE action = 'doc.deleted' ORDER BY scope_id`)).rows
    expect(audit.map(r => r.scope_id).toSorted()).toEqual([own1.docId, own2.docId].toSorted())
    expect(audit.every(r => r.metadata.reason === 'bulk')).toBe(true)
    expect(await version(a, ws.workspaceId)).toBeGreaterThan(v0)
  })

  it('files documents into a folder of their own scope, one result each', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const a = await loggedInClient(admin.id)
    const target = await folder(a, ws.workspaceId, 'Target')
    const d1 = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    const d2 = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    const personal = await createDoc({ ownerId: admin.id })
    const res = await a.post('/api/documents/bulk', { action: 'move-folder', docIds: [d1.docId, d2.docId, personal.docId], folderId: target })
    const body = await res.json() as BulkAnswer
    expect(body).toMatchObject({ ok: 2, failed: 1 })
    expect(body.results.find(r => r.id === personal.docId)).toMatchObject({ ok: false, code: 'folder/not-found' })
    const audit = (await testDb().query(`SELECT 1 FROM audit_log WHERE action = 'doc.folder_moved'`)).rowCount
    expect(audit).toBe(2)
  })

  it('moves documents to another workspace when the caller may manage them', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const a = await loggedInClient(admin.id)
    const f = await folder(a, ws.workspaceId, 'Filed')
    const doc = await createDoc({ ownerId: admin.id })
    const res = await a.post('/api/documents/bulk', { action: 'move-workspace', docIds: [doc.docId], workspaceId: ws.workspaceId })
    expect(((await res.json()) as BulkAnswer).ok).toBe(1)
    expect((await a.patch(`/api/docs/${doc.docId}/folder`, { folderId: f })).status).toBe(200)
    // Back to personal: the folder of the old scope is left.
    const back = await a.post('/api/documents/bulk', { action: 'move-workspace', docIds: [doc.docId], workspaceId: null })
    expect(((await back.json()) as BulkAnswer).ok).toBe(1)
    const row = (await testDb().query<{ workspace_id: string | null, folder_id: string | null }>('SELECT workspace_id, folder_id FROM documents WHERE doc_id = $1', [doc.docId])).rows[0]
    expect(row).toEqual({ workspace_id: null, folder_id: null })
  })
})

describe('POST /api/folders/bulk-move', () => {
  beforeEach(resetDb)

  it('moves folders and documents together; a cycle is refused for that folder only', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const a = await loggedInClient(admin.id)
    const target = await folder(a, ws.workspaceId, 'Target')
    const inner = await folder(a, ws.workspaceId, 'Inner', target)
    const loose = await folder(a, ws.workspaceId, 'Loose')
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    const res = await a.post('/api/folders/bulk-move', { workspaceId: ws.workspaceId, targetFolderId: inner, folderIds: [loose, target], docIds: [doc.docId] })
    const body = await res.json() as BulkAnswer
    expect(body.results.find(r => r.id === loose)?.ok).toBe(true)
    expect(body.results.find(r => r.id === target)).toMatchObject({ ok: false, code: 'folder/cycle' })
    expect(body.results.find(r => r.id === doc.docId)?.ok).toBe(true)
    const wrongScope = await a.post('/api/folders/bulk-move', { workspaceId: null, targetFolderId: inner, folderIds: [], docIds: [doc.docId] })
    expect(await code(wrongScope)).toBe('folder/not-found')
  })
})

describe('DELETE /api/folders/:folderId', () => {
  beforeEach(resetDb)

  it('is refused for an editor who does not own every document below, allowed for the admin', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const a = await loggedInClient(admin.id)
    const e = await loggedInClient(editor.id)
    const top = await folder(a, ws.workspaceId, 'Top')
    const sub = await folder(a, ws.workspaceId, 'Sub', top)
    const mine = await createDoc({ ownerId: editor.id, workspaceId: ws.workspaceId })
    const theirs = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    await a.post('/api/documents/bulk', { action: 'move-folder', docIds: [mine.docId], folderId: top })
    await a.post('/api/documents/bulk', { action: 'move-folder', docIds: [theirs.docId], folderId: sub })

    const preview = await (await e.get(`/api/folders/${top}/delete-preview`)).json()
    expect(preview).toEqual({ folders: 2, documents: 2, blocked: 1 })
    const refused = await e.delete(`/api/folders/${top}`)
    expect(refused.status).toBe(403)
    expect(await code(refused)).toBe('folder/delete-blocked')
    expect(await exists(mine.docId)).toBe(true)
    expect(await exists(theirs.docId)).toBe(true)

    const v0 = await version(a, ws.workspaceId)
    const ok = await a.delete(`/api/folders/${top}`)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ folders: 2, documents: 2 })
    expect(await exists(mine.docId)).toBe(false)
    expect(await exists(theirs.docId)).toBe(false)
    expect((await testDb().query('SELECT 1 FROM folders')).rowCount).toBe(0)
    const audit = (await testDb().query<{ action: string, metadata: { reason?: string } | null }>(`SELECT action, metadata FROM audit_log WHERE action IN ('doc.deleted', 'folder.deleted') ORDER BY id`)).rows
    expect(audit.filter(r => r.action === 'doc.deleted').map(r => r.metadata?.reason)).toEqual(['folder_deleted', 'folder_deleted'])
    expect(audit.filter(r => r.action === 'folder.deleted')).toHaveLength(1)
    expect(await version(a, ws.workspaceId)).toBeGreaterThan(v0)
  })

  it('lets an editor delete a folder whose documents are all theirs', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const e = await loggedInClient(editor.id)
    const f = await folder(e, ws.workspaceId, 'Mine')
    const doc = await createDoc({ ownerId: editor.id, workspaceId: ws.workspaceId })
    await e.patch(`/api/docs/${doc.docId}/folder`, { folderId: f })
    expect((await e.delete(`/api/folders/${f}`)).status).toBe(200)
    expect(await exists(doc.docId)).toBe(false)
  })
})
