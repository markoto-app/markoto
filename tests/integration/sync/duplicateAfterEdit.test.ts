import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createDoc, createUser } from '../setup/fixtures'
import { writeDocAs, type SyncClient } from '../setup/byok'

// Regression: duplicating a document right after an edit cloned the persisted Y.js rows from BEFORE the edit.
// The sync-server debounces its store 2–10 s, and `duplicateDocument` reads `yjs_updates`, so the duplicate
// endpoint asks the sync-server to persist pending edits first (`/internal/flush-document`).
//
// The edit below is acknowledged by the sync-server (it has it in memory) but well inside the 2 s store
// debounce when the duplicate request goes out: no waiting in between.

async function persistedText(docId: string): Promise<string> {
  const rows = await testDb().query<{ value: Buffer }>(
    'SELECT data AS value FROM yjs_updates WHERE doc_id = $1 ORDER BY id',
    [docId]
  )
  const doc = new Y.Doc()
  for (const r of rows.rows) Y.applyUpdate(doc, new Uint8Array(r.value))
  const text = doc.getText('content').toString()
  doc.destroy()
  return text
}

const clients: SyncClient[] = []

beforeEach(async () => {
  await resetDb()
})

afterEach(() => {
  for (const c of clients.splice(0)) c.destroy()
})

describe('POST /api/docs/:docId/duplicate right after an edit', () => {
  it('the copy contains the edit made a moment before', async () => {
    const owner = await createUser()
    const source = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    const line = `Q3 launch postmortem template ${Date.now()}`

    // The owner edits through the sync server and stays connected,
    // like an open editor tab. The store debounce is still running.
    clients.push(await writeDocAs(source.docId, { userId: String(owner.id), userName: owner.name }, line))

    const client = await loggedInClient(owner.id)
    const res = await client.post(`/api/docs/${source.docId}/duplicate`)
    expect(res.status).toBe(200)
    const body: unknown = await res.json()
    const copyId = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).docId : null
    expect(typeof copyId).toBe('string')

    expect(await persistedText(String(copyId))).toContain(line)
  })
})
