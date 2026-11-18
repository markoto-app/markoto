import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ListObjectsV2Command } from '@aws-sdk/client-s3'
import { resetDb, testDb } from '../integration/setup/db'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../integration/setup/fixtures'
import { createFolder, moveDocToFolder } from '../../server/repos/folders'
import { __mintWorkspaceAccess, __userActor } from '../../server/repos/proofs/testing'
import { asUser, docAs } from '../helpers/access'
import { proverFor } from '../../server/utils/api/policyProver'
import { FOLDER_MAX_DEPTH } from '../../shared/config/imports'

// The explorer's use cases against the test database: per-item decisions of
// the bulk actions (partial success, codes, audit rows), folder create /
// rename / move / delete with their refusals, the folder scope proofs, and
// the document pages and searches behind the explorer routes.

// The background clean-up after a delete reaches storage through the
// Nitro auto-import; an empty bucket is all these tests need.
vi.stubGlobal('useS3Client', () => ({
  send: async (cmd: unknown) => (cmd instanceof ListObjectsV2Command ? { Contents: [], IsTruncated: false } : {})
}))

const { moveDocsToFolder, moveDocsToWorkspace, deleteDocsBulk, bulkMove, deleteFolderTree } = await import('../../server/utils/explorer/bulkActions')
const { createFolderInScope, updateFolder, folderDeletePreview, folderBreadcrumb, searchEverywhere } = await import('../../server/utils/explorer/folderActions')
const { listDocsPage, folderTree } = await import('../../server/utils/explorer/docLists')
const { proveFolderScope, proveScope } = await import('../../server/utils/access/folderProof')

const IP = '203.0.113.7'

function wsAdmin(workspaceId: string, userId: number) {
  return __mintWorkspaceAccess(__userActor(userId), workspaceId, 'admin', 'editor')
}

async function folder(scope: Parameters<typeof createFolder>[0], id: string, parentId: string | null = null, name = id) {
  return createFolder(scope, { folderId: id, name, parentId })
}

async function docRow(docId: string) {
  return (await testDb().query<{ folder_id: string | null, workspace_id: string | null }>('SELECT folder_id, workspace_id FROM documents WHERE doc_id = $1', [docId])).rows[0]
}

async function folderExists(folderId: string): Promise<boolean> {
  return (await testDb().query('SELECT 1 FROM folders WHERE folder_id = $1', [folderId])).rows.length > 0
}

interface AuditRow { action: string, scope: string, scope_id: string, workspace_id: string | null, actor_user_id: number | null, before: unknown, after: unknown, metadata: Record<string, unknown> | null }

async function audits(action?: string): Promise<AuditRow[]> {
  const r = await testDb().query<AuditRow>(
    `SELECT action, scope, scope_id, workspace_id, actor_user_id, before, after, metadata FROM audit_log ${action ? 'WHERE action = $1' : ''} ORDER BY id`,
    action ? [action] : []
  )
  return r.rows
}

const codes = (rs: Array<{ id: string, ok: boolean, code?: string }>) => Object.fromEntries(rs.map(r => [r.id, r.ok ? 'ok' : r.code]))

describe('bulk: file documents into a folder', () => {
  beforeEach(resetDb)

  it('moves what the caller may edit and refuses the rest one by one', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const viewer = await createUser()
    const ws = await createWorkspace(admin.id)
    const other = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    await folder(wsAdmin(ws.workspaceId, admin.id), 'f')
    await folder(wsAdmin(other.workspaceId, admin.id), 'elsewhere')
    const a = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    const b = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    const foreign = await createDoc({ ownerId: admin.id })

    const results = await moveDocsToFolder({ userId: editor.id, ip: IP }, [a.docId, b.docId, foreign.docId, 'no-such-doc'], 'f')
    expect(codes(results)).toEqual({ [a.docId]: 'ok', [b.docId]: 'ok', [foreign.docId]: 'docs/edit-forbidden', 'no-such-doc': 'docs/edit-forbidden' })
    expect((await docRow(a.docId))?.folder_id).toBe('f')
    const moved = await audits('doc.folder_moved')
    expect(moved).toHaveLength(2)
    expect(moved[0]).toMatchObject({ scope: 'doc', scope_id: a.docId, workspace_id: ws.workspaceId, actor_user_id: editor.id, before: { folderId: null }, after: { folderId: 'f' } })

    // A viewer may not file documents.
    expect(codes(await moveDocsToFolder({ userId: viewer.id, ip: null }, [a.docId], null))).toEqual({ [a.docId]: 'docs/edit-forbidden' })
    // A folder of another workspace is not found from this document.
    expect(codes(await moveDocsToFolder({ userId: admin.id, ip: null }, [a.docId], 'elsewhere'))).toEqual({ [a.docId]: 'folder/not-found' })
    expect((await docRow(a.docId))?.folder_id).toBe('f')
    // Filing into the folder it is already in succeeds without another audit row.
    expect(codes(await moveDocsToFolder({ userId: admin.id, ip: null }, [a.docId], 'f'))).toEqual({ [a.docId]: 'ok' })
    expect(await audits('doc.folder_moved')).toHaveLength(2)
  })
})

describe('bulk: move documents between workspaces', () => {
  beforeEach(resetDb)

  it('needs manage on the document and an editor role in the target', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const target = await createWorkspace(bob.id)
    const viewerOnly = await createWorkspace(bob.id)
    const outsider = await createWorkspace(bob.id)
    await setMemberRole(target.workspaceId, alice.id, 'editor')
    await setMemberRole(viewerOnly.workspaceId, alice.id, 'viewer')
    const mine = await createDoc({ ownerId: alice.id })
    const second = await createDoc({ ownerId: alice.id })
    const third = await createDoc({ ownerId: alice.id })
    const bobs = await createDoc({ ownerId: bob.id })
    const actor = { userId: alice.id, ip: IP }
    const prove = proverFor(alice.id)

    expect(codes(await moveDocsToWorkspace(actor, prove, [mine.docId, bobs.docId], target.workspaceId)))
      .toEqual({ [mine.docId]: 'ok', [bobs.docId]: 'share/move-not-allowed' })
    expect((await docRow(mine.docId))?.workspace_id).toBe(target.workspaceId)
    expect(await audits('doc.workspace_moved')).toEqual([expect.objectContaining({ scope_id: mine.docId, workspace_id: null, before: { workspaceId: null }, after: { workspaceId: target.workspaceId } })])

    expect(codes(await moveDocsToWorkspace(actor, prove, [second.docId], viewerOnly.workspaceId))).toEqual({ [second.docId]: 'share/move-target-viewer' })
    expect(codes(await moveDocsToWorkspace(actor, prove, [third.docId], outsider.workspaceId))).toEqual({ [third.docId]: 'auth/forbidden' })
    expect((await docRow(second.docId))?.workspace_id).toBeNull()
    // Already there: nothing to do, no audit row.
    expect(codes(await moveDocsToWorkspace(actor, prove, [second.docId], null))).toEqual({ [second.docId]: 'ok' })
    expect(await audits('doc.workspace_moved')).toHaveLength(1)
  })

  it('drops guest shares and the folder when a document leaves its workspace', async () => {
    const admin = await createUser()
    const guest = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, guest.id, 'guest')
    await folder(wsAdmin(ws.workspaceId, admin.id), 'f')
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    await moveDocToFolder(docAs(doc.docId), 'f')
    await testDb().query(`INSERT INTO document_shares (doc_id, user_id, access, granted_by_user_id) VALUES ($1, $2, 'view', $3)`, [doc.docId, guest.id, admin.id])

    const [result] = await moveDocsToWorkspace({ userId: admin.id, ip: null }, proverFor(admin.id), [doc.docId], null)
    expect(result).toMatchObject({ ok: true })
    expect(await docRow(doc.docId)).toEqual({ folder_id: null, workspace_id: null })
    expect((await testDb().query('SELECT 1 FROM document_shares WHERE doc_id = $1', [doc.docId])).rows).toHaveLength(0)
    expect((await audits('doc.workspace_moved'))[0]).toMatchObject({ workspace_id: ws.workspaceId, metadata: { guestSharesRemoved: 1 } })
  })
})

describe('bulk: delete documents', () => {
  beforeEach(resetDb)

  it('deletes what the caller may delete and audits each one', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const own = await createDoc({ ownerId: alice.id, title: 'Mine' })
    const theirs = await createDoc({ ownerId: bob.id })
    const results = await deleteDocsBulk({ userId: alice.id, ip: IP }, [own.docId, theirs.docId], { reason: 'bulk' })
    expect(codes(results)).toEqual({ [own.docId]: 'ok', [theirs.docId]: 'docs/delete-forbidden' })
    expect(await docRow(own.docId)).toBeUndefined()
    expect(await docRow(theirs.docId)).toBeDefined()
    expect(await audits('doc.deleted')).toEqual([expect.objectContaining({
      scope_id: own.docId,
      actor_user_id: alice.id,
      before: expect.objectContaining({ title: 'Mine', ownerId: alice.id, workspaceId: null }),
      metadata: { reason: 'bulk' }
    })])
  })
})

describe('bulk: move folders and documents', () => {
  beforeEach(resetDb)

  it('moves folders and documents of one scope, refusing each item on its own', async () => {
    const admin = await createUser()
    const viewer = await createUser()
    const ws = await createWorkspace(admin.id)
    const other = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const scope = wsAdmin(ws.workspaceId, admin.id)
    await folder(scope, 'target')
    await folder(scope, 'a')
    await folder(scope, 'a-child', 'a')
    await folder(scope, 'dup', null, 'Taken')
    await folder(scope, 'taken', 'target', 'Taken')
    await folder(wsAdmin(other.workspaceId, admin.id), 'other-ws')
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    const actor = { userId: admin.id, ip: IP }

    const results = await bulkMove(actor, { workspaceId: ws.workspaceId, targetFolderId: 'target', folderIds: ['a', 'dup', 'other-ws', 'target'], docIds: [doc.docId] })
    expect(codes(results)).toEqual({ 'a': 'ok', 'dup': 'folder/name-taken', 'other-ws': 'folder/not-found', 'target': 'folder/cycle', [doc.docId]: 'ok' })
    expect((await docRow(doc.docId))?.folder_id).toBe('target')
    expect(await audits('folder.moved')).toEqual([expect.objectContaining({ scope: 'workspace', scope_id: ws.workspaceId, before: { parentId: null }, after: { parentId: 'target' }, metadata: { folderId: 'a' } })])

    // Into its own subfolder: a cycle.
    expect(codes(await bulkMove(actor, { workspaceId: ws.workspaceId, targetFolderId: 'a-child', folderIds: ['a'], docIds: [] }))).toEqual({ a: 'folder/cycle' })
    // Back to the root of the scope.
    expect(codes(await bulkMove(actor, { workspaceId: ws.workspaceId, targetFolderId: null, folderIds: ['a'], docIds: [] }))).toEqual({ a: 'ok' })
    // A viewer may not move folders.
    expect(codes(await bulkMove({ userId: viewer.id, ip: null }, { workspaceId: ws.workspaceId, targetFolderId: null, folderIds: ['a'], docIds: [] }))).toEqual({ a: 'folder/not-found' })
  })

  it('refuses a target folder outside the named scope as a whole', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await folder(asUser(admin.id), 'personal')
    await expect(bulkMove({ userId: admin.id, ip: null }, { workspaceId: ws.workspaceId, targetFolderId: 'personal', folderIds: [], docIds: [] }))
      .rejects.toMatchObject({ statusCode: 404, data: { code: 'folder/not-found' } })
    await expect(bulkMove({ userId: admin.id, ip: null }, { workspaceId: ws.workspaceId, targetFolderId: 'missing', folderIds: [], docIds: [] }))
      .rejects.toMatchObject({ data: { code: 'folder/not-found' } })
  })

  it('reports a move that would nest too deep', async () => {
    const alice = await createUser()
    const scope = asUser(alice.id)
    let parent: string | null = null
    for (let i = 1; i <= FOLDER_MAX_DEPTH; i++) {
      await folder(scope, `l${i}`, parent)
      parent = `l${i}`
    }
    await folder(scope, 'loose')
    expect(codes(await bulkMove({ userId: alice.id, ip: null }, { workspaceId: null, targetFolderId: `l${FOLDER_MAX_DEPTH}`, folderIds: ['loose'], docIds: [] })))
      .toEqual({ loose: 'folder/too-deep' })
  })
})

describe('delete a folder tree', () => {
  beforeEach(resetDb)

  it('is refused as a whole while it holds documents the editor may not delete', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const viewer = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const scope = wsAdmin(ws.workspaceId, admin.id)
    await folder(scope, 'top')
    await folder(scope, 'sub', 'top')
    const adminsDoc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    const editorsDoc = await createDoc({ ownerId: editor.id, workspaceId: ws.workspaceId })
    await moveDocToFolder(docAs(adminsDoc.docId), 'sub')
    await moveDocToFolder(docAs(editorsDoc.docId), 'top')

    expect(await folderDeletePreview(editor.id, 'top')).toEqual({ folders: 2, documents: 2, blocked: 1 })
    await expect(deleteFolderTree({ userId: editor.id, ip: null }, 'top')).rejects.toMatchObject({ statusCode: 403, data: { code: 'folder/delete-blocked', blocked: 1 } })
    expect(await folderExists('top')).toBe(true)
    expect(await docRow(editorsDoc.docId)).toBeDefined()
    await expect(deleteFolderTree({ userId: viewer.id, ip: null }, 'top')).rejects.toMatchObject({ data: { code: 'folder/not-found' } })
    await expect(folderDeletePreview(viewer.id, 'top')).rejects.toMatchObject({ data: { code: 'folder/not-found' } })

    // A workspace admin may delete everything below it.
    expect(await folderDeletePreview(admin.id, 'top')).toEqual({ folders: 2, documents: 2, blocked: 0 })
    expect(await deleteFolderTree({ userId: admin.id, ip: IP }, 'top')).toEqual({ folders: 2, documents: 2 })
    expect(await folderExists('top')).toBe(false)
    expect(await folderExists('sub')).toBe(false)
    expect(await docRow(adminsDoc.docId)).toBeUndefined()
    expect(await docRow(editorsDoc.docId)).toBeUndefined()
    const deleted = await audits('doc.deleted')
    expect(deleted.map(r => r.metadata)).toEqual([{ reason: 'folder_deleted', folderId: 'top' }, { reason: 'folder_deleted', folderId: 'top' }])
    expect(await audits('folder.deleted')).toEqual([expect.objectContaining({ scope: 'workspace', before: { name: 'top', parentId: null }, metadata: { folderId: 'top', folders: 2, documents: 2 } })])
  })

  it('lets the owner delete a personal folder, and nobody else', async () => {
    const alice = await createUser()
    const bob = await createUser()
    await folder(asUser(alice.id), 'p')
    const doc = await createDoc({ ownerId: alice.id })
    await moveDocToFolder(docAs(doc.docId), 'p')
    await expect(deleteFolderTree({ userId: bob.id, ip: null }, 'p')).rejects.toMatchObject({ data: { code: 'folder/not-found' } })
    expect(await deleteFolderTree({ userId: alice.id, ip: null }, 'p')).toEqual({ folders: 1, documents: 1 })
    expect(await audits('folder.deleted')).toEqual([expect.objectContaining({ scope: 'user', scope_id: String(alice.id), workspace_id: null })])
  })
})

describe('folder use cases', () => {
  beforeEach(resetDb)

  it('creates folders, refusing a taken name and an unknown parent', async () => {
    const alice = await createUser()
    const ws = await createWorkspace(alice.id)
    const proof = await proveScope(alice.id, ws.workspaceId, 'editor')
    if (!proof) throw new Error('no proof')
    const created = await createFolderInScope(proof, { userId: alice.id, ip: IP }, 'Projects', null)
    expect(created).toMatchObject({ parentId: null, name: 'Projects', docCount: 0 })
    expect(await audits('folder.created')).toEqual([expect.objectContaining({ scope: 'workspace', scope_id: ws.workspaceId, metadata: { folderId: created.folderId, name: 'Projects', parentId: null } })])
    await expect(createFolderInScope(proof, { userId: alice.id, ip: null }, 'projects', null)).rejects.toMatchObject({ statusCode: 409, data: { code: 'folder/name-taken' } })
    await expect(createFolderInScope(proof, { userId: alice.id, ip: null }, 'Child', 'missing')).rejects.toMatchObject({ data: { code: 'folder/not-found' } })
  })

  it('renames and moves, auditing only what changed', async () => {
    const alice = await createUser()
    const scope = asUser(alice.id)
    await folder(scope, 'p', null, 'Parent')
    await folder(scope, 'c', 'p', 'Child')
    await folder(scope, 'g', 'c', 'Grandchild')
    const actor = { userId: alice.id, ip: null }

    expect(await updateFolder(actor, 'c', { name: 'Renamed' })).toMatchObject({ folderId: 'c', name: 'Renamed', parentId: 'p' })
    expect(await audits('folder.renamed')).toEqual([expect.objectContaining({ scope: 'user', before: { name: 'Child' }, after: { name: 'Renamed' } })])
    // The same name again: no audit row.
    await updateFolder(actor, 'c', { name: 'Renamed' })
    expect(await audits('folder.renamed')).toHaveLength(1)

    expect(await updateFolder(actor, 'c', { parentId: null, name: 'Moved' })).toMatchObject({ name: 'Moved', parentId: null })
    expect(await audits('folder.moved')).toEqual([expect.objectContaining({ before: { parentId: 'p' }, after: { parentId: null } })])
    expect(await audits('folder.renamed')).toHaveLength(2)

    await expect(updateFolder(actor, 'c', { parentId: 'g' })).rejects.toMatchObject({ statusCode: 409, data: { code: 'folder/cycle' } })
    await expect(updateFolder(actor, 'c', { name: 'Parent' })).rejects.toMatchObject({ data: { code: 'folder/name-taken' } })
    await expect(updateFolder(actor, 'c', { parentId: 'missing' })).rejects.toMatchObject({ data: { code: 'folder/not-found' } })
    await expect(updateFolder({ userId: (await createUser()).id, ip: null }, 'c', { name: 'x' })).rejects.toMatchObject({ data: { code: 'folder/not-found' } })
    // A no-op update returns the folder unchanged.
    expect(await updateFolder(actor, 'c', {})).toMatchObject({ name: 'Moved' })
  })

  it('refuses a move past the depth limit with the limit', async () => {
    const alice = await createUser()
    const scope = asUser(alice.id)
    let parent: string | null = null
    for (let i = 1; i <= FOLDER_MAX_DEPTH; i++) {
      await folder(scope, `l${i}`, parent)
      parent = `l${i}`
    }
    await folder(scope, 'loose')
    await expect(updateFolder({ userId: alice.id, ip: null }, 'loose', { parentId: `l${FOLDER_MAX_DEPTH}` }))
      .rejects.toMatchObject({ data: { code: 'folder/too-deep', max: FOLDER_MAX_DEPTH } })
  })

  it('gives breadcrumbs to members only', async () => {
    const admin = await createUser()
    const viewer = await createUser()
    const outsider = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    await folder(wsAdmin(ws.workspaceId, admin.id), 'a', null, 'A')
    await folder(wsAdmin(ws.workspaceId, admin.id), 'b', 'a', 'B')
    const crumb = await folderBreadcrumb(viewer.id, 'b')
    expect(crumb.workspaceId).toBe(ws.workspaceId)
    expect(crumb.path.map(p => p.name)).toEqual(['A', 'B'])
    await expect(folderBreadcrumb(outsider.id, 'b')).rejects.toMatchObject({ data: { code: 'folder/not-found' } })
  })
})

describe('folder scope proofs', () => {
  beforeEach(resetDb)

  it('reaches workspace folders through the role and personal ones only as their owner', async () => {
    const admin = await createUser()
    const viewer = await createUser()
    const guest = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    await setMemberRole(ws.workspaceId, guest.id, 'guest')
    await folder(wsAdmin(ws.workspaceId, admin.id), 'wf')
    await folder(asUser(admin.id), 'pf')

    expect(await proveFolderScope(viewer.id, 'wf', 'member')).toMatchObject({ kind: 'workspace', workspaceId: ws.workspaceId })
    expect(await proveFolderScope(viewer.id, 'wf', 'editor')).toBeNull()
    expect(await proveFolderScope(guest.id, 'wf', 'member')).toBeNull()
    expect(await proveFolderScope(admin.id, 'pf', 'admin')).toMatchObject({ kind: 'personal', workspaceId: null })
    expect(await proveFolderScope(viewer.id, 'pf', 'member')).toBeNull()
    expect(await proveFolderScope(admin.id, 'missing', 'member')).toBeNull()

    expect(await proveScope(viewer.id, null, 'admin')).toMatchObject({ kind: 'personal' })
    expect(await proveScope(viewer.id, ws.workspaceId, 'member')).toMatchObject({ kind: 'workspace' })
    expect(await proveScope(viewer.id, ws.workspaceId, 'editor')).toBeNull()
  })
})

describe('document pages and search', () => {
  beforeEach(resetDb)

  it('pages a scope by cursor and refuses a bad cursor or an unknown folder', async () => {
    const alice = await createUser()
    const ws = await createWorkspace(alice.id)
    const scope = __mintWorkspaceAccess(__userActor(alice.id), ws.workspaceId, 'admin', 'member')
    await folder(wsAdmin(ws.workspaceId, alice.id), 'f', null, 'F')
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push((await createDoc({ ownerId: alice.id, workspaceId: ws.workspaceId, title: `Doc ${i}` })).docId)
    await moveDocToFolder(docAs(ids[0] as string), 'f')
    const self = asUser(alice.id)

    const first = await listDocsPage(self, scope, { folder: 'all', sort: 'title', limit: 3 })
    expect(first.items.map(d => d.title)).toEqual(['Doc 0', 'Doc 1', 'Doc 2'])
    expect(first.total).toBe(5)
    expect(first.items[0]).toMatchObject({ isOwner: true, folderId: 'f', wordCount: 0 })
    expect(first.nextCursor).not.toBeNull()
    const second = await listDocsPage(self, scope, { folder: 'all', sort: 'title', limit: 3, cursor: first.nextCursor ?? undefined })
    expect(second.items.map(d => d.title)).toEqual(['Doc 3', 'Doc 4'])
    expect(second.nextCursor).toBeNull()

    expect((await listDocsPage(self, scope, { folder: 'root', sort: 'updated', limit: 10 })).total).toBe(4)
    expect((await listDocsPage(self, scope, { folder: 'f', sort: 'updated', dir: 'asc', limit: 10 })).items.map(d => d.docId)).toEqual([ids[0]])
    await expect(listDocsPage(self, scope, { folder: 'all', sort: 'updated', limit: 3, cursor: 'garbage' })).rejects.toMatchObject({ statusCode: 400, data: { code: 'request/invalid', field: 'cursor' } })
    await expect(listDocsPage(self, scope, { folder: 'nope', sort: 'updated', limit: 3 })).rejects.toMatchObject({ data: { code: 'folder/not-found' } })

    expect(await folderTree(scope)).toEqual([expect.objectContaining({ folderId: 'f', parentId: null, name: 'F', docCount: 1 })])
  })

  it('searches a scope or one folder subtree, paging by offset', async () => {
    const alice = await createUser()
    const self = asUser(alice.id)
    await folder(self, 'top')
    await folder(self, 'sub', 'top')
    const inSub = await createDoc({ ownerId: alice.id, title: 'Budget sub' })
    const atRoot = await createDoc({ ownerId: alice.id, title: 'Budget root' })
    await createDoc({ ownerId: alice.id, title: 'Budget third' })
    await createDoc({ ownerId: alice.id, title: 'Unrelated' })
    await moveDocToFolder(docAs(inSub.docId), 'sub')

    const page1 = await listDocsPage(self, self, { folder: 'all', sort: 'updated', q: 'budg', limit: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.nextCursor).toBe('2')
    expect(page1.items[0]?.snippet).toBeDefined()
    const page2 = await listDocsPage(self, self, { folder: 'all', sort: 'updated', q: 'budg', limit: 2, cursor: page1.nextCursor ?? undefined })
    expect(page2.items).toHaveLength(1)
    expect(page2.total).toBe(3)
    expect(page2.nextCursor).toBeNull()
    expect(new Set([...page1.items, ...page2.items].map(d => d.docId)).size).toBe(3)

    const inFolder = await listDocsPage(self, self, { folder: 'top', sort: 'updated', q: 'budget', limit: 10 })
    expect(inFolder.items.map(d => d.docId)).toEqual([inSub.docId])
    expect(atRoot.docId).not.toBe(inSub.docId)
  })

  it('searches everywhere the caller can reach, or one scope', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const ws = await createWorkspace(bob.id, { name: 'Team space' })
    const notMine = await createWorkspace(bob.id)
    await setMemberRole(ws.workspaceId, alice.id, 'viewer')
    await folder(wsAdmin(ws.workspaceId, bob.id), 'wf')
    await folder(asUser(alice.id), 'pf')
    const personal = await createDoc({ ownerId: alice.id, title: 'Zebra personal' })
    const wsDoc = await createDoc({ ownerId: bob.id, workspaceId: ws.workspaceId, title: 'Zebra workspace' })
    const filed = await createDoc({ ownerId: bob.id, workspaceId: ws.workspaceId, title: 'Zebra filed' })
    await createDoc({ ownerId: bob.id, workspaceId: notMine.workspaceId, title: 'Zebra hidden' })
    await moveDocToFolder(docAs(filed.docId), 'wf')
    const self = asUser(alice.id)
    const q = { q: 'zebra', limit: 20, offset: 0 }

    const all = await searchEverywhere(self, { ...q, scope: 'all' })
    expect(all.results.map(r => r.docId).toSorted()).toEqual([personal.docId, wsDoc.docId, filed.docId].toSorted())
    expect(all.results.find(r => r.docId === wsDoc.docId)).toMatchObject({ workspaceId: ws.workspaceId, workspaceName: 'Team space' })
    expect(all.results.find(r => r.docId === personal.docId)).toMatchObject({ workspaceId: null, workspaceName: null })
    expect(all.hasMore).toBe(false)

    expect((await searchEverywhere(self, { ...q, scope: 'personal' })).results.map(r => r.docId)).toEqual([personal.docId])
    expect((await searchEverywhere(self, { ...q, scope: `ws:${ws.workspaceId}` })).results).toHaveLength(2)
    expect((await searchEverywhere(self, { ...q, scope: `ws:${ws.workspaceId}`, folder: 'wf' })).results.map(r => r.docId)).toEqual([filed.docId])
    expect((await searchEverywhere(self, { ...q, scope: 'personal', folder: 'pf' })).results).toEqual([])
    const limited = await searchEverywhere(self, { ...q, scope: 'all', limit: 1 })
    expect(limited.results).toHaveLength(1)
    expect(limited.hasMore).toBe(true)

    await expect(searchEverywhere(self, { ...q, scope: `ws:${notMine.workspaceId}` })).rejects.toMatchObject({ data: { code: 'workspace/not-found' } })
    // A folder of another scope than the one searched is not found.
    await expect(searchEverywhere(self, { ...q, scope: 'personal', folder: 'wf' })).rejects.toMatchObject({ data: { code: 'folder/not-found' } })
    await expect(searchEverywhere(self, { ...q, scope: `ws:${ws.workspaceId}`, folder: 'pf' })).rejects.toMatchObject({ data: { code: 'folder/not-found' } })
  })
})
