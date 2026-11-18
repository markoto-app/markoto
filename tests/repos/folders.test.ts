import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../integration/setup/fixtures'
import {
  createFolder,
  deleteFolderRow,
  folderDeletePlan,
  folderPath,
  getFolder,
  listFolders,
  moveDocToFolder,
  moveFolder,
  renameFolder,
  ensureChildFolder
} from '../../server/repos/folders'
import { ConflictError, DuplicateError, NotFoundError } from '../../server/repos/errors'
import { __mintWorkspaceAccess, __userActor } from '../../server/repos/proofs/testing'
import type { WorkspaceMemberRole } from '../../server/repos/proofs'
import { asUser, docAs } from '../helpers/access'
import { FOLDER_MAX_DEPTH } from '../../shared/config/imports'

// Folders of a workspace and of a user's personal documents: every query is
// held to the proof's scope, the tree stays a tree, sibling names stay
// unique, and the explorer change counters move only on listed changes.

function wsEditor(workspaceId: string, userId: number, role: WorkspaceMemberRole = 'editor') {
  return __mintWorkspaceAccess(__userActor(userId), workspaceId, role, 'editor')
}

async function folder(scope: Parameters<typeof createFolder>[0], id: string, parentId: string | null = null, name = id) {
  return createFolder(scope, { folderId: id, name, parentId })
}

async function docFolder(docId: string): Promise<string | null> {
  return (await testDb().query<{ folder_id: string | null }>('SELECT folder_id FROM documents WHERE doc_id = $1', [docId])).rows[0]?.folder_id ?? null
}

async function wsVersion(workspaceId: string): Promise<number> {
  return Number((await testDb().query<{ v: string }>('SELECT explorer_version AS v FROM workspaces WHERE workspace_id = $1', [workspaceId])).rows[0]?.v)
}

async function userVersion(userId: number): Promise<number> {
  return Number((await testDb().query<{ v: string }>('SELECT explorer_version AS v FROM users WHERE id = $1', [userId])).rows[0]?.v)
}

describe('folders: scopes', () => {
  beforeEach(resetDb)

  it('keeps workspace and personal folders apart', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const ws = await createWorkspace(alice.id)
    const other = await createWorkspace(bob.id)
    await folder(wsEditor(ws.workspaceId, alice.id, 'admin'), 'ws-f')
    await folder(wsEditor(other.workspaceId, bob.id, 'admin'), 'other-f')
    await folder(asUser(alice.id), 'alice-f')
    await folder(asUser(bob.id), 'bob-f')

    expect((await listFolders(wsEditor(ws.workspaceId, alice.id, 'admin'))).map(f => f.folderId)).toEqual(['ws-f'])
    expect((await listFolders(asUser(alice.id))).map(f => f.folderId)).toEqual(['alice-f'])
    // A folder id of another workspace or another user is not found.
    expect(await getFolder(wsEditor(ws.workspaceId, alice.id, 'admin'), 'other-f')).toBeNull()
    expect(await getFolder(asUser(alice.id), 'bob-f')).toBeNull()
    expect(await getFolder(asUser(alice.id), 'ws-f')).toBeNull()
    await expect(renameFolder(asUser(alice.id), 'bob-f', 'x')).rejects.toBeInstanceOf(NotFoundError)
    await expect(createFolder(asUser(alice.id), { folderId: 'child', name: 'c', parentId: 'ws-f' })).rejects.toBeInstanceOf(NotFoundError)
    await expect(moveFolder(wsEditor(ws.workspaceId, alice.id, 'admin'), 'ws-f', 'other-f')).rejects.toBeInstanceOf(NotFoundError)
    expect(await deleteFolderRow(asUser(alice.id), 'bob-f')).toBe(false)
    expect(await getFolder(asUser(bob.id), 'bob-f')).not.toBeNull()
  })

  it('counts the documents filed directly in each folder', async () => {
    const alice = await createUser()
    const ws = await createWorkspace(alice.id)
    const scope = wsEditor(ws.workspaceId, alice.id, 'admin')
    await folder(scope, 'a')
    await folder(scope, 'b', 'a')
    const d1 = await createDoc({ ownerId: alice.id, workspaceId: ws.workspaceId })
    const d2 = await createDoc({ ownerId: alice.id, workspaceId: ws.workspaceId })
    await moveDocToFolder(docAs(d1.docId), 'a')
    await moveDocToFolder(docAs(d2.docId), 'b')
    const rows = await listFolders(scope)
    expect(rows.map(r => [r.folderId, r.docCount])).toEqual([['a', 1], ['b', 1]])
  })

  it('refuses a duplicate sibling name, case-insensitively, but allows it elsewhere', async () => {
    const alice = await createUser()
    const scope = asUser(alice.id)
    await folder(scope, 'a', null, 'Notes')
    await expect(folder(scope, 'b', null, 'notes')).rejects.toBeInstanceOf(DuplicateError)
    await folder(scope, 'c', 'a', 'NOTES')
    await folder(scope, 'd', null, 'Other')
    await expect(renameFolder(scope, 'd', 'nOtEs')).rejects.toBeInstanceOf(DuplicateError)
    // Moving a folder next to a namesake is refused too.
    await expect(moveFolder(scope, 'c', null)).rejects.toBeInstanceOf(DuplicateError)
    // Another user's personal folders are another scope.
    const bob = await createUser()
    await folder(asUser(bob.id), 'e', null, 'Notes')
  })

  it('ensureChildFolder finds an existing name and creates a missing one', async () => {
    const alice = await createUser()
    const scope = asUser(alice.id)
    await folder(scope, 'a', null, 'Docs')
    let n = 0
    expect(await ensureChildFolder(scope, null, 'docs', () => `new-${++n}`)).toBe('a')
    expect(await ensureChildFolder(scope, 'a', 'Sub', () => `new-${++n}`)).toBe('new-1')
    expect(await ensureChildFolder(scope, 'a', 'SUB', () => `new-${++n}`)).toBe('new-1')
  })
})

describe('folders: tree rules', () => {
  beforeEach(resetDb)

  it('refuses moving a folder into itself or below itself', async () => {
    const alice = await createUser()
    const scope = asUser(alice.id)
    await folder(scope, 'a')
    await folder(scope, 'b', 'a')
    await folder(scope, 'c', 'b')
    await expect(moveFolder(scope, 'a', 'a')).rejects.toThrow(ConflictError)
    await expect(moveFolder(scope, 'a', 'c')).rejects.toThrow('folder-cycle')
    expect((await getFolder(scope, 'a'))?.parentId).toBeNull()
    // A legal move works and reports the old parent.
    expect(await moveFolder(scope, 'c', null)).toEqual({ before: 'b' })
    expect((await folderPath(scope, 'c')).map(p => p.folderId)).toEqual(['c'])
  })

  it('renames and moves in one update, so a refused move keeps the old name', async () => {
    const alice = await createUser()
    const scope = asUser(alice.id)
    await folder(scope, 'p', null, 'Parent')
    await folder(scope, 'c', 'p', 'Child')
    await folder(scope, 'taken', null, 'Taken')
    await expect(moveFolder(scope, 'c', null, 'taken')).rejects.toBeInstanceOf(DuplicateError)
    expect(await getFolder(scope, 'c')).toMatchObject({ name: 'Child', parentId: 'p' })
    await moveFolder(scope, 'c', null, 'Moved')
    expect(await getFolder(scope, 'c')).toMatchObject({ name: 'Moved', parentId: null })
  })

  it('enforces the depth limit on create and on move (counting the moved subtree)', async () => {
    const alice = await createUser()
    const scope = asUser(alice.id)
    let parent: string | null = null
    for (let i = 1; i <= FOLDER_MAX_DEPTH; i++) {
      await folder(scope, `l${i}`, parent)
      parent = `l${i}`
    }
    expect((await folderPath(scope, `l${FOLDER_MAX_DEPTH}`)).length).toBe(FOLDER_MAX_DEPTH)
    await expect(folder(scope, 'too-deep', `l${FOLDER_MAX_DEPTH}`)).rejects.toThrow('folder-too-deep')

    // A two-level subtree fits under level FOLDER_MAX_DEPTH - 2, not below that.
    await folder(scope, 'x')
    await folder(scope, 'x2', 'x')
    await expect(moveFolder(scope, 'x', `l${FOLDER_MAX_DEPTH - 1}`)).rejects.toThrow('folder-too-deep')
    await expect(moveFolder(scope, 'x', `l${FOLDER_MAX_DEPTH - 2}`)).resolves.toEqual({ before: null })
  })
})

describe('folders: filing documents', () => {
  beforeEach(resetDb)

  it('files a document only into a folder of its own scope', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const ws = await createWorkspace(alice.id)
    const other = await createWorkspace(alice.id)
    await folder(wsEditor(ws.workspaceId, alice.id, 'admin'), 'ws-f')
    await folder(wsEditor(other.workspaceId, alice.id, 'admin'), 'other-f')
    await folder(asUser(alice.id), 'alice-f')
    await folder(asUser(bob.id), 'bob-f')
    const wsDoc = await createDoc({ ownerId: alice.id, workspaceId: ws.workspaceId })
    const personal = await createDoc({ ownerId: alice.id })

    await expect(moveDocToFolder(docAs(wsDoc.docId), 'alice-f')).rejects.toBeInstanceOf(NotFoundError)
    await expect(moveDocToFolder(docAs(wsDoc.docId), 'other-f')).rejects.toBeInstanceOf(NotFoundError)
    await expect(moveDocToFolder(docAs(personal.docId), 'ws-f')).rejects.toBeInstanceOf(NotFoundError)
    await expect(moveDocToFolder(docAs(personal.docId), 'bob-f')).rejects.toBeInstanceOf(NotFoundError)
    expect(await docFolder(wsDoc.docId)).toBeNull()

    expect(await moveDocToFolder(docAs(wsDoc.docId), 'ws-f')).toEqual({ before: null })
    expect(await moveDocToFolder(docAs(personal.docId), 'alice-f')).toEqual({ before: null })
    expect(await docFolder(wsDoc.docId)).toBe('ws-f')
    expect(await moveDocToFolder(docAs(wsDoc.docId), null)).toEqual({ before: 'ws-f' })
    expect(await docFolder(wsDoc.docId)).toBeNull()
  })
})

describe('folderDeletePlan', () => {
  beforeEach(resetDb)

  it('lists the subtree and counts documents the actor may not delete', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const adminScope = wsEditor(ws.workspaceId, admin.id, 'admin')
    await folder(adminScope, 'top')
    await folder(adminScope, 'sub', 'top')
    await folder(adminScope, 'elsewhere')
    const mine = await createDoc({ ownerId: editor.id, workspaceId: ws.workspaceId })
    const theirs = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    const outside = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    await moveDocToFolder(docAs(mine.docId), 'top')
    await moveDocToFolder(docAs(theirs.docId), 'sub')
    await moveDocToFolder(docAs(outside.docId), 'elsewhere')

    const asAdmin = await folderDeletePlan(adminScope, 'top')
    expect(asAdmin?.folderIds).toEqual(['top', 'sub'])
    expect(asAdmin?.docIds.toSorted()).toEqual([mine.docId, theirs.docId].toSorted())
    expect(asAdmin?.blockedDocs).toBe(0)

    const asEditor = await folderDeletePlan(wsEditor(ws.workspaceId, editor.id), 'top')
    expect(asEditor?.blockedDocs).toBe(1)
    // Once the admin's document is filed elsewhere the editor owns everything below `top`.
    await moveDocToFolder(docAs(theirs.docId), null)
    expect((await folderDeletePlan(wsEditor(ws.workspaceId, editor.id), 'top'))?.blockedDocs).toBe(0)

    expect(await folderDeletePlan(adminScope, 'missing')).toBeNull()
    expect(await folderDeletePlan(asUser(admin.id), 'top')).toBeNull()
  })

  it('deleting the folder row removes its subfolders and unfiles nothing else', async () => {
    const alice = await createUser()
    const scope = asUser(alice.id)
    await folder(scope, 'a')
    await folder(scope, 'b', 'a')
    await folder(scope, 'keep')
    expect(await deleteFolderRow(scope, 'a')).toBe(true)
    expect((await listFolders(scope)).map(f => f.folderId)).toEqual(['keep'])
  })
})

describe('explorer change counters', () => {
  beforeEach(resetDb)

  it('bump the workspace counter on folder and document changes', async () => {
    const alice = await createUser()
    const ws = await createWorkspace(alice.id)
    const scope = wsEditor(ws.workspaceId, alice.id, 'admin')
    let v = await wsVersion(ws.workspaceId)
    const expectBump = async (what: string) => {
      const now = await wsVersion(ws.workspaceId)
      expect(now, what).toBeGreaterThan(v)
      v = now
    }

    await folder(scope, 'a')
    await expectBump('folder create')
    await folder(scope, 'b')
    await expectBump('folder create')
    await renameFolder(scope, 'a', 'Renamed')
    await expectBump('folder rename')
    await moveFolder(scope, 'b', 'a')
    await expectBump('folder move')

    const doc = await createDoc({ ownerId: alice.id, workspaceId: ws.workspaceId })
    await expectBump('doc insert')
    await testDb().query(`UPDATE documents SET title = 'New title' WHERE doc_id = $1`, [doc.docId])
    await expectBump('doc title')
    await moveDocToFolder(docAs(doc.docId), 'b')
    await expectBump('doc folder move')

    // Counts written by the sync server are not listed changes.
    await testDb().query(`UPDATE documents SET word_count = 42, size_bytes = 300, last_active = now(), updated_at = now() WHERE doc_id = $1`, [doc.docId])
    expect(await wsVersion(ws.workspaceId)).toBe(v)
    // Neither is a title written back unchanged.
    await testDb().query(`UPDATE documents SET title = 'New title' WHERE doc_id = $1`, [doc.docId])
    expect(await wsVersion(ws.workspaceId)).toBe(v)

    await testDb().query('DELETE FROM documents WHERE doc_id = $1', [doc.docId])
    await expectBump('doc delete')
    await deleteFolderRow(scope, 'a')
    await expectBump('folder delete')
  })

  it('bump the personal counter, and both when a document changes scope', async () => {
    const alice = await createUser()
    const ws = await createWorkspace(alice.id)
    let u = await userVersion(alice.id)
    await folder(asUser(alice.id), 'p')
    expect(await userVersion(alice.id)).toBeGreaterThan(u)
    u = await userVersion(alice.id)
    const doc = await createDoc({ ownerId: alice.id })
    expect(await userVersion(alice.id)).toBeGreaterThan(u)
    u = await userVersion(alice.id)
    const w = await wsVersion(ws.workspaceId)
    await testDb().query('UPDATE documents SET workspace_id = $2 WHERE doc_id = $1', [doc.docId, ws.workspaceId])
    expect(await userVersion(alice.id)).toBeGreaterThan(u)
    expect(await wsVersion(ws.workspaceId)).toBeGreaterThan(w)
  })
})
