import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import { insertYjsUpdate, readYjsRows, resetDb, testDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createDoc, createUser } from '../setup/fixtures'
import { connectSync, waitFor, waitForAcked, type SyncClient } from '../setup/byok'

// The real sync-test container persisting to `yjs_updates`: what it stores
// is what a later load (and the app's history replay) sees, two clients
// converge on one stored state, and the Activity Log boundary ids it
// records drive diff and restore end to end.

const clients: SyncClient[] = []

// SYNC_UNLOAD_GRACE_MS of the sync-test container (compose.test.yml): how
// long a document stays loaded after its last client left.
const UNLOAD_GRACE_MS = 2000

function track(c: SyncClient): SyncClient {
  clients.push(c)
  return c
}

async function storedState(docId: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  for (const row of await readYjsRows(docId)) Y.applyUpdate(doc, row.data)
  return doc
}

async function storedText(docId: string): Promise<string> {
  return (await storedState(docId)).getText('content').toJSON()
}

async function waitForStoredText(docId: string, expected: string): Promise<void> {
  await waitFor(async () => ((await storedText(docId)) === expected ? true : null), 20_000, `stored text "${expected}"`)
}

async function typeInto(c: SyncClient, text: string): Promise<void> {
  c.doc.transact(() => {
    const t = c.doc.getText('content')
    t.insert(t.length, text)
  })
  await waitForAcked(c)
}

interface EditRow { id: number, yjs_doc_id_before: number | null, yjs_doc_id_after: number | null }

async function editRows(docId: string): Promise<EditRow[]> {
  const r = await testDb().query<{ id: number, yjs_doc_id_before: string | null, yjs_doc_id_after: string | null }>(
    `SELECT id, yjs_doc_id_before, yjs_doc_id_after FROM activity_log
     WHERE doc_id = $1 AND action = 'edit' ORDER BY id`,
    [docId]
  )
  return r.rows.map(row => ({
    id: row.id,
    yjs_doc_id_before: row.yjs_doc_id_before === null ? null : Number(row.yjs_doc_id_before),
    yjs_doc_id_after: row.yjs_doc_id_after === null ? null : Number(row.yjs_doc_id_after)
  }))
}

beforeEach(async () => {
  await resetDb()
})

afterEach(() => {
  for (const c of clients.splice(0)) c.destroy()
})

describe('sync server persistence', () => {
  it('edits survive the document leaving memory; a reload reads the stored log', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
    const identity = { userId: String(owner.id), userName: owner.name }

    const writer = track(connectSync(doc.docId, identity))
    await writer.synced
    await typeInto(writer, 'stored before leaving.')
    writer.destroy()
    // The last client leaving stores at once (the grace period does not
    // delay the store) and the document unloads after the grace period.
    await waitForStoredText(doc.docId, 'stored before leaving.')
    expect((await readYjsRows(doc.docId)).every(r => r.kind === 'update')).toBe(true)
    await new Promise(r => setTimeout(r, UNLOAD_GRACE_MS + 1000))

    // Another instance appends while the document is not loaded here.
    const elsewhere = await storedState(doc.docId)
    const sv = Y.encodeStateVector(elsewhere)
    elsewhere.getText('content').insert(elsewhere.getText('content').length, ' Then elsewhere.')
    await insertYjsUpdate(doc.docId, Y.encodeStateAsUpdate(elsewhere, sv))

    // Seeing the other instance's row proves this load came from the table.
    const reader = track(connectSync(doc.docId, identity))
    await reader.synced
    expect(reader.doc.getText('content').toJSON()).toBe('stored before leaving. Then elsewhere.')
  }, 40_000)

  it('a reconnect within the grace period finds the document still in memory; after it the document loads again', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
    const identity = { userId: String(owner.id), userName: owner.name }

    const writer = track(connectSync(doc.docId, identity))
    await writer.synced
    await typeInto(writer, 'kept in memory.')
    writer.destroy()
    await waitForStoredText(doc.docId, 'kept in memory.')

    // A row the loaded document doesn't have: only a fresh load reads it.
    const elsewhere = await storedState(doc.docId)
    const sv = Y.encodeStateVector(elsewhere)
    elsewhere.getText('content').insert(elsewhere.getText('content').length, ' Loaded again.')
    await insertYjsUpdate(doc.docId, Y.encodeStateAsUpdate(elsewhere, sv))

    // Within the grace period: served from memory, no database load.
    const quick = track(connectSync(doc.docId, identity))
    await quick.synced
    expect(quick.doc.getText('content').toJSON()).toBe('kept in memory.')
    quick.destroy()

    // The reconnect restarted the grace; once it is over the document unloads.
    await new Promise(r => setTimeout(r, UNLOAD_GRACE_MS + 1000))
    const later = track(connectSync(doc.docId, identity))
    await later.synced
    expect(later.doc.getText('content').toJSON()).toBe('kept in memory. Loaded again.')
  }, 40_000)

  it('two clients converge, and the stored log replays to their shared state', async () => {
    const doc = await createDoc({ accessMode: 'open-edit' })
    const a = track(connectSync(doc.docId, { userId: 'anonymous', userName: null }))
    const b = track(connectSync(doc.docId, { userId: 'anonymous', userName: null }))
    await Promise.all([a.synced, b.synced])
    await Promise.all([typeInto(a, 'A1 '), typeInto(b, 'B1 ')])
    await typeInto(a, 'A2 ')
    await waitFor(async () => (a.doc.getText('content').toJSON() === b.doc.getText('content').toJSON() ? true : null), 10_000, 'convergence')
    const shared = a.doc.getText('content').toJSON()
    for (const part of ['A1', 'B1', 'A2']) expect(shared).toContain(part)

    a.destroy()
    b.destroy()
    await waitForStoredText(doc.docId, shared)
  }, 40_000)

  it('records the stored row ids on edit rows; diff and restore (and restoring the restore) work on them', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    const editor = track(connectSync(doc.docId, { userId: String(owner.id), userName: owner.name }))
    await editor.synced

    await typeInto(editor, 'First paragraph.\n')
    const [firstEdit] = await waitFor(async () => {
      const rows = await editRows(doc.docId)
      return rows.length >= 1 ? rows : null
    }, 20_000, 'the first edit row')
    await typeInto(editor, 'Second paragraph.\n')
    const rows = await waitFor(async () => {
      const r = await editRows(doc.docId)
      return r.length >= 2 ? r : null
    }, 20_000, 'the second edit row')
    const second = rows[1]!

    // Boundary ids are real rows; the second edit starts where the first ended.
    const ids = (await readYjsRows(doc.docId)).map(r => r.id)
    expect(ids).toContain(firstEdit!.yjs_doc_id_after)
    expect(ids).toContain(second.yjs_doc_id_after)
    expect(second.yjs_doc_id_before).toBe(firstEdit!.yjs_doc_id_after)

    const client = await loggedInClient(owner.id)
    const diff = await client.get(`/api/docs/${doc.docId}/activity/${second.id}/diff`)
    expect(diff.status).toBe(200)
    const diffBody = await diff.json() as { before: string, after: string }
    expect(diffBody.before).toBe('First paragraph.\n')
    expect(diffBody.after).toBe('First paragraph.\nSecond paragraph.\n')

    const restore = await client.post(`/api/docs/${doc.docId}/activity/${second.id}/restore`, {})
    expect(restore.status).toBe(200)
    await waitFor(async () => (editor.doc.getText('content').toJSON() === 'First paragraph.\n' ? true : null), 10_000, 'the restored text')

    const restoreRow = await waitFor(async () => {
      const r = await testDb().query<{ id: number }>(
        `SELECT id FROM activity_log WHERE doc_id = $1 AND action = 'restore' ORDER BY id DESC LIMIT 1`,
        [doc.docId]
      )
      return r.rows[0] ?? null
    }, 10_000, 'the restore row')
    const undo = await client.post(`/api/docs/${doc.docId}/activity/${restoreRow.id}/restore`, {})
    expect(undo.status).toBe(200)
    await waitFor(async () => (editor.doc.getText('content').toJSON() === 'First paragraph.\nSecond paragraph.\n' ? true : null), 10_000, 'the text before the restore')
    await waitForStoredText(doc.docId, 'First paragraph.\nSecond paragraph.\n')
  }, 90_000)
})
