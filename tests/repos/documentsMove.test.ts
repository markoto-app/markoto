import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  getDoc,
  moveDocToWorkspace,
  insertDuplicateDoc,
  listOwnedByUser
} from '../../server/repos/documents'
import { NotFoundError } from '../../server/repos/errors'
import { createUser, createDoc as seedDoc, createWorkspace } from '../integration/setup/fixtures'
import type { DocTheme } from '../../shared/types/theme'

// Extension tests for the documents repo: the move and duplicate helpers
// added for post-creation workspace moves and document duplication. The
// existing documents.test.ts covers the original CRUD; these tests pin
// the newer invariants (lastActive bump, metadata fidelity, full-row copy).

describe('moveDocToWorkspace', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('assigns the target workspaceId', async () => {
    const user = await createUser()
    const ws = await createWorkspace(user.id)
    const doc = await seedDoc({ ownerId: user.id })
    expect(doc.workspaceId).toBeNull()

    await moveDocToWorkspace(doc.docId, ws.workspaceId)

    const after = (await getDoc(doc.docId))!
    expect(after.workspaceId).toBe(ws.workspaceId)
  })

  it('detaches a doc when passed null', async () => {
    const user = await createUser()
    const ws = await createWorkspace(user.id)
    const doc = await seedDoc({ ownerId: user.id, workspaceId: ws.workspaceId })

    await moveDocToWorkspace(doc.docId, null)

    const after = (await getDoc(doc.docId))!
    expect(after.workspaceId).toBeNull()
  })

  it('moves between workspaces', async () => {
    const user = await createUser()
    const wsA = await createWorkspace(user.id)
    const wsB = await createWorkspace(user.id)
    const doc = await seedDoc({ ownerId: user.id, workspaceId: wsA.workspaceId })

    await moveDocToWorkspace(doc.docId, wsB.workspaceId)

    const after = (await getDoc(doc.docId))!
    expect(after.workspaceId).toBe(wsB.workspaceId)
  })

  it('bumps lastActive so the moved doc surfaces in "recent"', async () => {
    const user = await createUser()
    const ws = await createWorkspace(user.id)
    const doc = await seedDoc({ ownerId: user.id })
    const db = testDb()
    await db.query(
      `UPDATE documents SET last_active = now() - interval '1 day' WHERE doc_id = $1`,
      [doc.docId]
    )
    const before = (await getDoc(doc.docId))!.lastActive

    await moveDocToWorkspace(doc.docId, ws.workspaceId)

    const after = (await getDoc(doc.docId))!.lastActive
    expect(after.getTime()).toBeGreaterThan(before.getTime())
  })

  it('does not touch other metadata (title / accessMode / theme / counters)', async () => {
    const user = await createUser()
    const ws = await createWorkspace(user.id)
    const doc = await seedDoc({ ownerId: user.id, accessMode: 'password-protected', passwordHash: 'hash' })
    const db = testDb()
    // Seed counters + theme directly so we can prove they're untouched.
    await db.query(
      `UPDATE documents SET word_count = 500, size_bytes = 4000,
         theme = '{"foo":"bar"}'::jsonb
       WHERE doc_id = $1`,
      [doc.docId]
    )

    await moveDocToWorkspace(doc.docId, ws.workspaceId)

    const after = (await getDoc(doc.docId))!
    expect(after.title).toBe('Test Doc')
    expect(after.accessMode).toBe('password-protected')
    expect(after.passwordHash).toBe('hash')
    expect(after.wordCount).toBe(500)
    expect(after.sizeBytes).toBe(4000)
    expect(after.theme).toEqual({ foo: 'bar' })
  })

  it('throws NotFoundError when the doc is missing', async () => {
    await expect(moveDocToWorkspace('ghost', null))
      .rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('insertDuplicateDoc', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('creates a new row mirroring the inherited fields', async () => {
    const user = await createUser()
    const theme: DocTheme = {
      page: { size: 'A4', orientation: 'portrait' }
    } as unknown as DocTheme
    // We don't care about theme semantics here, just that the JSONB
    // round-trips through the duplicate path unchanged. Using a minimal
    // object keeps the test independent of the DocTheme shape evolving.

    await insertDuplicateDoc({
      newDocId: 'copy-doc',
      ownerId: user.id,
      workspaceId: null,
      title: 'Copy of X',
      accessMode: 'password-protected',
      passwordHash: 'inherited-hash',
      theme,
      wordCount: 42,
      sizeBytes: 1234
    })

    const snap = (await getDoc('copy-doc'))!
    expect(snap.ownerId).toBe(user.id)
    expect(snap.workspaceId).toBeNull()
    expect(snap.title).toBe('Copy of X')
    expect(snap.accessMode).toBe('password-protected')
    expect(snap.passwordHash).toBe('inherited-hash')
    expect(snap.wordCount).toBe(42)
    expect(snap.sizeBytes).toBe(1234)
    expect(snap.theme).toEqual(theme)
  })

  it('null counters coerce to 0 (matches schema defaults)', async () => {
    // Source docs sometimes have NULL wordCount/sizeBytes if the writer
    // never reported them. The duplicate row should still be valid
    // (default 0) rather than carrying the NULL forward.
    const user = await createUser()
    await insertDuplicateDoc({
      newDocId: 'copy-nulls',
      ownerId: user.id,
      workspaceId: null,
      title: 'T',
      accessMode: 'open-edit',
      passwordHash: null,
      theme: null,
      wordCount: null,
      sizeBytes: null
    })
    const snap = (await getDoc('copy-nulls'))!
    expect(snap.wordCount).toBe(0)
    expect(snap.sizeBytes).toBe(0)
    expect(snap.theme).toBeNull()
  })

  it('can assign a workspace at insert time', async () => {
    const user = await createUser()
    const ws = await createWorkspace(user.id)
    await insertDuplicateDoc({
      newDocId: 'copy-ws',
      ownerId: user.id,
      workspaceId: ws.workspaceId,
      title: 'T',
      accessMode: 'private',
      passwordHash: null,
      theme: null,
      wordCount: 0,
      sizeBytes: 0
    })
    const snap = (await getDoc('copy-ws'))!
    expect(snap.workspaceId).toBe(ws.workspaceId)
  })

  it('listOwnedByUser surfaces the duplicate for its new owner', async () => {
    // Regression target: a duplicate owned by the duplicator (not the
    // source owner) must show up on THEIR dashboard. listOwnedByUser
    // scopes by ownerId so this happens naturally — test pins it.
    const alice = await createUser()
    const bob = await createUser()
    await seedDoc({ ownerId: alice.id })
    await insertDuplicateDoc({
      newDocId: 'copy-bob',
      ownerId: bob.id, // Bob duplicates Alice's doc
      workspaceId: null,
      title: 'Copy',
      accessMode: 'private',
      passwordHash: null,
      theme: null,
      wordCount: 0,
      sizeBytes: 0
    })

    const bobsDocs = await listOwnedByUser(bob.id)
    expect(bobsDocs.map(d => d.docId)).toContain('copy-bob')

    const alicesDocs = await listOwnedByUser(alice.id)
    expect(alicesDocs.map(d => d.docId)).not.toContain('copy-bob')
  })
})

describe('listOwnedByUser shape additions', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns workspaceId on each row so the dashboard can preselect the move modal', async () => {
    const user = await createUser()
    const ws = await createWorkspace(user.id)
    const inWs = await seedDoc({ ownerId: user.id, workspaceId: ws.workspaceId })
    const standalone = await seedDoc({ ownerId: user.id })

    const rows = await listOwnedByUser(user.id)
    const byId = new Map(rows.map(r => [r.docId, r]))
    expect(byId.get(inWs.docId)!.workspaceId).toBe(ws.workspaceId)
    expect(byId.get(standalone.docId)!.workspaceId).toBeNull()
  })
})
