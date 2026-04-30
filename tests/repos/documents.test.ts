import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  getDoc,
  docExists,
  getDocWithActorRole,
  createDoc,
  updateDocMeta,
  setDocPassword,
  clearDocPassword,
  bumpLastActive,
  deleteDocRow,
  listOwnedByUser,
  listAllDocIds,
  listDocIdsInWorkspace,
  listWorkspaceDocsWithOwnerFlag
} from '../../server/repos/documents'
import { NotFoundError } from '../../server/repos/errors'
import { createUser, createDoc as seedDoc, createWorkspace, setMemberRole } from '../integration/setup/fixtures'

// Documents repo. Covers CRUD round-trips, the three-way
// getDocWithActorRole join (anonymous / member / non-member), partial
// updates with lastActive bump, and the password/accessMode coupling
// side-effects.

describe('getDoc / docExists', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns null for a nonexistent docId', async () => {
    expect(await getDoc('missing')).toBeNull()
    expect(await docExists('missing')).toBe(false)
  })

  it('returns a fully-hydrated snapshot for an existing doc', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id, accessMode: 'private' })
    const snap = await getDoc(doc.docId)
    expect(snap).not.toBeNull()
    expect(snap!.docId).toBe(doc.docId)
    expect(snap!.ownerId).toBe(user.id)
    expect(snap!.accessMode).toBe('private')
    expect(snap!.title).toBe('Test Doc')
    expect(snap!.passwordHash).toBeNull()
    expect(snap!.createdAt).toBeInstanceOf(Date)
    expect(snap!.lastActive).toBeInstanceOf(Date)
  })

  it('docExists returns true for an existing doc without fetching the whole row', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    expect(await docExists(doc.docId)).toBe(true)
  })
})

describe('getDocWithActorRole', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns role=null for an anonymous caller', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const doc = await seedDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, accessMode: 'private' })
    const row = await getDocWithActorRole(doc.docId, null)
    expect(row).not.toBeNull()
    expect(row!.ownerId).toBe(owner.id)
    expect(row!.workspaceRole).toBeNull()
  })

  it('returns the correct role for a workspace member', async () => {
    const creator = await createUser()
    const member = await createUser()
    const ws = await createWorkspace(creator.id)
    await setMemberRole(ws.workspaceId, member.id, 'editor')
    const doc = await seedDoc({ ownerId: creator.id, workspaceId: ws.workspaceId, accessMode: 'private' })
    const row = await getDocWithActorRole(doc.docId, member.id)
    expect(row!.workspaceRole).toBe('editor')
  })

  it('returns role=null for a logged-in non-member', async () => {
    // A user who exists but isn't in the workspace shouldn't accidentally
    // pick up someone else's role via a bad JOIN predicate.
    const owner = await createUser()
    const stranger = await createUser()
    const ws = await createWorkspace(owner.id)
    const doc = await seedDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, accessMode: 'private' })
    const row = await getDocWithActorRole(doc.docId, stranger.id)
    expect(row!.workspaceRole).toBeNull()
  })

  it('returns role=null for a non-workspace doc (nothing to join on)', async () => {
    const owner = await createUser()
    const doc = await seedDoc({ ownerId: owner.id, accessMode: 'private' })
    const row = await getDocWithActorRole(doc.docId, owner.id)
    expect(row!.workspaceRole).toBeNull()
  })

  it('returns null for a nonexistent doc', async () => {
    expect(await getDocWithActorRole('ghost', null)).toBeNull()
  })

  it('never cross-joins roles from OTHER workspaces', async () => {
    // Pathological regression target: if the leftJoin predicate only
    // compared userId without the workspaceId constraint, a member of
    // workspace-A would appear as having a role on a doc from
    // workspace-B. This is the exact bug that would silently leak
    // membership across workspace boundaries.
    const creator = await createUser()
    const member = await createUser()
    const wsA = await createWorkspace(creator.id)
    const wsB = await createWorkspace(creator.id)
    await setMemberRole(wsA.workspaceId, member.id, 'admin')
    // `member` is admin of wsA but NOT a member of wsB at all.
    const docB = await seedDoc({ ownerId: creator.id, workspaceId: wsB.workspaceId, accessMode: 'private' })
    const row = await getDocWithActorRole(docB.docId, member.id)
    expect(row!.workspaceRole).toBeNull()
  })
})

describe('createDoc / deleteDocRow', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('creates a doc with the supplied fields', async () => {
    const user = await createUser()
    await createDoc({ docId: 'new-doc', ownerId: user.id, workspaceId: null, accessMode: 'private' })
    const snap = await getDoc('new-doc')
    expect(snap).not.toBeNull()
    expect(snap!.accessMode).toBe('private')
  })

  it('supports anonymous docs (null ownerId + open-edit)', async () => {
    await createDoc({ docId: 'anon-doc', ownerId: null, workspaceId: null, accessMode: 'open-edit' })
    const snap = await getDoc('anon-doc')
    expect(snap!.ownerId).toBeNull()
  })

  it('deleteDocRow removes the row', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await deleteDocRow(doc.docId)
    expect(await docExists(doc.docId)).toBe(false)
  })
})

describe('updateDocMeta', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('applies a partial title update and bumps lastActive', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    const before = (await getDoc(doc.docId))!.lastActive
    await new Promise(r => setTimeout(r, 10))
    await updateDocMeta(doc.docId, { title: 'Renamed' })
    const after = (await getDoc(doc.docId))!
    expect(after.title).toBe('Renamed')
    expect(after.lastActive.getTime()).toBeGreaterThan(before.getTime())
  })

  it('preserves fields not in the update', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id, accessMode: 'private' })
    await updateDocMeta(doc.docId, { wordCount: 123 })
    const after = (await getDoc(doc.docId))!
    expect(after.wordCount).toBe(123)
    expect(after.accessMode).toBe('private') // untouched
    expect(after.title).toBe('Test Doc') // untouched
  })

  it('is a no-op when the update object is empty', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    // Should not throw, should not bump lastActive.
    const before = (await getDoc(doc.docId))!.lastActive
    await updateDocMeta(doc.docId, {})
    const after = (await getDoc(doc.docId))!
    expect(after.lastActive.getTime()).toBe(before.getTime())
  })

  it('throws NotFoundError when the docId does not exist', async () => {
    await expect(updateDocMeta('missing', { title: 'x' }))
      .rejects.toBeInstanceOf(NotFoundError)
  })

  it('accessMode change persists', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id, accessMode: 'private' })
    await updateDocMeta(doc.docId, { accessMode: 'open-edit' })
    expect((await getDoc(doc.docId))!.accessMode).toBe('open-edit')
  })
})

describe('setDocPassword / clearDocPassword', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('set flips accessMode to password-protected and stores the hash', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id, accessMode: 'private' })
    await setDocPassword(doc.docId, 'hash-value')
    const after = (await getDoc(doc.docId))!
    expect(after.accessMode).toBe('password-protected')
    expect(after.passwordHash).toBe('hash-value')
  })

  it('clear flips accessMode to open-edit and nulls the hash', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id, accessMode: 'password-protected', passwordHash: 'prior' })
    await clearDocPassword(doc.docId)
    const after = (await getDoc(doc.docId))!
    expect(after.accessMode).toBe('open-edit')
    expect(after.passwordHash).toBeNull()
  })
})

describe('bumpLastActive', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('moves lastActive forward without touching other fields', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id, accessMode: 'private' })
    const db = testDb()
    await db.query(`UPDATE documents SET last_active = now() - interval '1 day' WHERE doc_id = $1`, [doc.docId])
    const before = (await getDoc(doc.docId))!
    await bumpLastActive(doc.docId)
    const after = (await getDoc(doc.docId))!
    expect(after.lastActive.getTime()).toBeGreaterThan(before.lastActive.getTime())
    expect(after.accessMode).toBe('private')
    expect(after.title).toBe('Test Doc')
  })
})

describe('list helpers', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('listOwnedByUser returns only that user\'s docs, ordered by lastActive desc', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const a1 = await seedDoc({ ownerId: alice.id })
    await new Promise(r => setTimeout(r, 5))
    const a2 = await seedDoc({ ownerId: alice.id })
    await seedDoc({ ownerId: bob.id })
    const docs = await listOwnedByUser(alice.id)
    expect(docs.map(d => d.docId)).toEqual([a2.docId, a1.docId])
  })

  it('listAllDocIds returns every doc (used by orphan-cleanup)', async () => {
    const u = await createUser()
    const d1 = await seedDoc({ ownerId: u.id })
    const d2 = await seedDoc({ ownerId: u.id })
    const ids = new Set(await listAllDocIds())
    expect(ids.has(d1.docId)).toBe(true)
    expect(ids.has(d2.docId)).toBe(true)
  })

  it('listDocIdsInWorkspace scopes to the target workspace', async () => {
    const creator = await createUser()
    const wsA = await createWorkspace(creator.id)
    const wsB = await createWorkspace(creator.id)
    const a1 = await seedDoc({ ownerId: creator.id, workspaceId: wsA.workspaceId })
    await seedDoc({ ownerId: creator.id, workspaceId: wsB.workspaceId })
    const ids = await listDocIdsInWorkspace(wsA.workspaceId)
    expect(ids).toEqual([a1.docId])
  })

  it('listWorkspaceDocsWithOwnerFlag surfaces isOwner per row', async () => {
    const creator = await createUser()
    const other = await createUser()
    const ws = await createWorkspace(creator.id)
    await setMemberRole(ws.workspaceId, other.id, 'editor')
    const mine = await seedDoc({ ownerId: other.id, workspaceId: ws.workspaceId })
    const theirs = await seedDoc({ ownerId: creator.id, workspaceId: ws.workspaceId })
    const rows = await listWorkspaceDocsWithOwnerFlag(ws.workspaceId, other.id)
    const byId = new Map(rows.map(r => [r.docId, r]))
    expect(byId.get(mine.docId)!.isOwner).toBe(true)
    expect(byId.get(theirs.docId)!.isOwner).toBe(false)
  })
})
