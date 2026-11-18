import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import jwt from 'jsonwebtoken'
import WebSocket from 'ws'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { newProvider } from '../../helpers/hocuspocus'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../setup/fixtures'
import { TEST_JWT_SECRET, TEST_SYNC_PORT } from '../setup/env'

// The explorer against documents that are open in an editor, over a real
// sync connection to the sync-test container:
//   - the sync server indexes what it stores, so the search finds a word
//     typed a moment ago (after the store debounce);
//   - a rename from the explorer reaches the open editor's live title;
//   - deleting the folder of an open document tells the editor it is gone;
//   - moving an open document to another folder doesn't disturb its editor.

const WS_URL = `ws://127.0.0.1:${TEST_SYNC_PORT}`

interface Client { provider: HocuspocusProvider, doc: Y.Doc, synced: boolean, closes: number }
const open: Client[] = []

function connect(docId: string, userId: number): Client {
  const doc = new Y.Doc()
  const token = jwt.sign({ docId, userId: String(userId), userName: `User ${userId}`, readOnly: false }, TEST_JWT_SECRET, { expiresIn: 600 })
  const client: Client = { provider: null as unknown as HocuspocusProvider, doc, synced: false, closes: 0 }
  client.provider = newProvider({
    url: WS_URL,
    name: docId,
    document: doc,
    token,
    WebSocketPolyfill: WebSocket,
    onSynced: () => {
      client.synced = true
    },
    onClose: () => {
      client.closes++
    }
  })
  open.push(client)
  return client
}

async function waitFor<T>(probe: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs = 20_000, what = 'condition'): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await probe()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor(${what}) timed out after ${timeoutMs}ms`)
    await new Promise(r => setTimeout(r, 200))
  }
}

async function indexedBody(docId: string): Promise<string | null> {
  return (await testDb().query<{ body: string }>('SELECT body FROM document_search WHERE doc_id = $1', [docId])).rows[0]?.body ?? null
}

beforeEach(resetDb)

afterEach(() => {
  for (const c of open.splice(0)) {
    c.provider.destroy()
    c.doc.destroy()
  }
})

describe('search over live edits', () => {
  it('finds a word typed in the editor once the sync server stored it', async () => {
    const alice = await createUser()
    const doc = await createDoc({ ownerId: alice.id, title: 'Plain title' })
    const c = connect(doc.docId, alice.id)
    await waitFor(() => c.synced, 10_000, 'synced')
    c.doc.getText('content').insert(0, 'The zanzibarian expedition starts Monday.')

    const a = await loggedInClient(alice.id)
    const hit = await waitFor(async () => {
      const res = await a.get('/api/search/documents?q=zanzibar')
      const body = await res.json() as { results: Array<{ docId: string, snippet: string }> }
      return body.results.find(r => r.docId === doc.docId)
    }, 25_000, 'search hit')
    expect(hit.snippet).toContain('zanzibarian')
    const row = (await testDb().query<{ word_count: number }>('SELECT word_count FROM documents WHERE doc_id = $1', [doc.docId])).rows[0]
    expect(row?.word_count).toBe(5)

    // Somebody without access finds nothing.
    const bob = await createUser()
    const b = await loggedInClient(bob.id)
    const none = await (await b.get('/api/search/documents?q=zanzibar')).json() as { results: unknown[] }
    expect(none.results).toEqual([])
  }, 40_000)
})

describe('renaming an open document', () => {
  it('updates the row and the live title of a connected editor', async () => {
    const alice = await createUser()
    const doc = await createDoc({ ownerId: alice.id, title: 'Before' })
    const c = connect(doc.docId, alice.id)
    await waitFor(() => c.synced, 10_000, 'synced')

    const a = await loggedInClient(alice.id)
    const res = await a.put(`/api/docs/${doc.docId}/title`, { title: 'After rename' })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(((await res.json()) as { live: boolean }).live).toBe(true)
    await waitFor(() => c.doc.getMap('meta').get('title') === 'After rename', 10_000, 'live title')
    const row = (await testDb().query<{ title: string }>('SELECT title FROM documents WHERE doc_id = $1', [doc.docId])).rows[0]
    expect(row?.title).toBe('After rename')
  }, 30_000)

  it('refuses a viewer', async () => {
    const owner = await createUser()
    const viewer = await createUser()
    const ws = await createWorkspace(owner.id)
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const doc = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, title: 'Keep' })
    const v = await loggedInClient(viewer.id)
    expect((await v.put(`/api/docs/${doc.docId}/title`, { title: 'Nope' })).status).toBe(403)
  })
})

describe('folder changes under an open editor', () => {
  it('deleting the folder tells the open editor its document is gone', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const ws = await createWorkspace(bob.id)
    await setMemberRole(ws.workspaceId, alice.id, 'editor')
    const b = await loggedInClient(bob.id)
    const folderId = ((await (await b.post(`/api/workspaces/${ws.workspaceId}/folders`, { name: 'Doomed' })).json()) as { folder: { folderId: string } }).folder.folderId
    const doc = await createDoc({ ownerId: alice.id, workspaceId: ws.workspaceId })
    expect((await b.patch(`/api/docs/${doc.docId}/folder`, { folderId })).status).toBe(200)

    const c = connect(doc.docId, alice.id)
    await waitFor(() => c.synced, 10_000, 'synced')
    const res = await b.delete(`/api/folders/${folderId}`)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, folders: 1, documents: 1 })
    await waitFor(() => c.doc.getMap('meta').get('_deleted') !== undefined, 15_000, 'notify-deleted')
    expect((await testDb().query('SELECT 1 FROM documents WHERE doc_id = $1', [doc.docId])).rowCount).toBe(0)
  }, 30_000)

  it('moving an open document to another folder keeps its editor syncing', async () => {
    const alice = await createUser()
    const a = await loggedInClient(alice.id)
    const f1 = ((await (await a.post('/api/user/folders', { name: 'One' })).json()) as { folder: { folderId: string } }).folder.folderId
    const f2 = ((await (await a.post('/api/user/folders', { name: 'Two' })).json()) as { folder: { folderId: string } }).folder.folderId
    const doc = await createDoc({ ownerId: alice.id })
    expect((await a.patch(`/api/docs/${doc.docId}/folder`, { folderId: f1 })).status).toBe(200)

    const c = connect(doc.docId, alice.id)
    await waitFor(() => c.synced, 10_000, 'synced')
    c.doc.getText('content').insert(0, 'first words ')
    await waitFor(async () => (await indexedBody(doc.docId))?.includes('first'), 20_000, 'first store')

    expect((await a.patch(`/api/docs/${doc.docId}/folder`, { folderId: f2 })).status).toBe(200)
    c.doc.getText('content').insert(c.doc.getText('content').length, 'quokkas after the move')
    await waitFor(async () => (await indexedBody(doc.docId))?.includes('quokkas'), 20_000, 'second store')
    expect(c.closes).toBe(0)
    const row = (await testDb().query<{ folder_id: string }>('SELECT folder_id FROM documents WHERE doc_id = $1', [doc.docId])).rows[0]
    expect(row?.folder_id).toBe(f2)
  }, 50_000)
})
