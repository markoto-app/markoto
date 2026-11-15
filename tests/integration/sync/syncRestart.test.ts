import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import jwt from 'jsonwebtoken'
import WebSocket from 'ws'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { newProvider } from '../../helpers/hocuspocus'
import { resetDb, getValkeyKey, setValkeyKey, testDb } from '../setup/db'
import { createDoc, createUser } from '../setup/fixtures'
import { loggedInClient } from '../setup/client'
import { TEST_JWT_SECRET } from '../setup/env'
import { syncProcess, type SyncProcess } from '../setup/syncProcess'
import { allSyncStateKeys } from '../../../shared/contracts/syncState'

// The sync server restarting under connected editors (every deploy), its
// capacity limits, and the per-document state it keeps in Valkey. Runs a
// sync server of its own (`setup/syncProcess.ts`) so it can be killed and
// started again without touching the shared `sync-test` container.

const RESTART_PORT = 4012
const BUSY_PORT = 4013

interface Client {
  doc: Y.Doc
  provider: HocuspocusProvider
  closes: Array<{ code: number, reason: string }>
  authFailures: string[]
  syncs: number
}

const openClients: Client[] = []

function mintToken(docId: string, userId = 'anonymous'): string {
  return jwt.sign({ docId, userId, userName: null, readOnly: false }, TEST_JWT_SECRET, { expiresIn: '10m' })
}

function connect(server: SyncProcess, docId: string): Client {
  const doc = new Y.Doc()
  const client: Client = { doc, provider: null as unknown as HocuspocusProvider, closes: [], authFailures: [], syncs: 0 }
  client.provider = newProvider({
    url: server.wsUrl,
    name: docId,
    document: doc,
    token: mintToken(docId),
    WebSocketPolyfill: WebSocket,
    onSynced: () => { client.syncs++ },
    onAuthenticationFailed: ({ reason }) => { client.authFailures.push(reason) },
    onClose: ({ event }) => { client.closes.push({ code: event.code, reason: event.reason }) }
  })
  openClients.push(client)
  return client
}

async function waitFor<T>(probe: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await probe()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`)
    await new Promise(r => setTimeout(r, 50))
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** What a client opening the document now gets from the server. */
async function serverText(server: SyncProcess, docId: string): Promise<string> {
  const reader = connect(server, docId)
  await waitFor(() => reader.syncs > 0)
  const text = reader.doc.getText('content').toJSON()
  reader.provider.destroy()
  return text
}

function rejections(c: Client) {
  return c.closes.filter(e => e.reason === 'invalid-update' || e.reason === 'invalid-meta')
}

afterEach(() => {
  for (const c of openClients.splice(0)) c.provider.destroy()
})

describe('sync server restart with edits made while it was down', () => {
  const server = syncProcess(RESTART_PORT)

  beforeAll(async () => {
    await server.start()
  }, 60_000)

  afterAll(async () => {
    await server.stop()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('a crash: edits typed offline on top of edits the server never stored are accepted and merged', async () => {
    const doc = await createDoc()
    const editor = connect(server, doc.docId)
    await waitFor(() => editor.syncs > 0)
    const text = editor.doc.getText('content')
    text.insert(0, 'hello')
    // Past the store debounce: "hello" is in Postgres.
    await sleep(3_000)
    // Received by the server, still in its store debounce when it dies.
    text.insert(5, ' abc')
    await sleep(300)
    await server.kill()
    // Typed while the server is down: queued, each one built on " abc".
    text.insert(9, 'd')
    text.insert(10, 'e')
    text.insert(11, 'f')
    await server.start()
    const syncsBefore = editor.syncs
    await waitFor(() => editor.syncs > syncsBefore)
    // Give the queued updates and the resync time to arrive.
    await waitFor(async () => (await serverText(server, doc.docId)) === 'hello abcdef' || null, 15_000)
    expect(rejections(editor)).toEqual([])
    expect(editor.authFailures).toEqual([])
    // Still connected and editing: no lockout.
    text.insert(12, '!')
    await waitFor(async () => (await serverText(server, doc.docId)) === 'hello abcdef!' || null, 15_000)
    expect(rejections(editor)).toEqual([])
  }, 90_000)

  it('a deploy (graceful stop): offline edits sync after the restart without a rejection', async () => {
    const doc = await createDoc()
    const editor = connect(server, doc.docId)
    await waitFor(() => editor.syncs > 0)
    const text = editor.doc.getText('content')
    text.insert(0, 'draft')
    await sleep(300)
    await server.stop()
    text.insert(5, ' typed offline')
    await server.start()
    await waitFor(async () => (await serverText(server, doc.docId)) === 'draft typed offline' || null, 20_000)
    expect(rejections(editor)).toEqual([])
    expect(editor.authFailures).toEqual([])
  }, 90_000)

  it('two editors: one keeps typing offline, the other stays on; both converge after the restart', async () => {
    const doc = await createDoc()
    const a = connect(server, doc.docId)
    const b = connect(server, doc.docId)
    await waitFor(() => a.syncs > 0 && b.syncs > 0)
    a.doc.getText('content').insert(0, 'A1 ')
    await waitFor(() => b.doc.getText('content').toJSON() === 'A1 ')
    b.doc.getText('content').insert(3, 'B1 ')
    await waitFor(() => a.doc.getText('content').toJSON() === 'A1 B1 ')
    await sleep(200)
    await server.kill()
    a.doc.getText('content').insert(6, 'A2 ')
    b.doc.getText('content').insert(0, 'B2 ')
    await server.start()
    await waitFor(() => {
      const ta = a.doc.getText('content').toJSON()
      return ta === b.doc.getText('content').toJSON() && ta.length === 12
    }, 30_000)
    const final = a.doc.getText('content').toJSON()
    for (const part of ['A1 ', 'B1 ', 'A2 ', 'B2 ']) expect(final).toContain(part)
    await waitFor(async () => (await serverText(server, doc.docId)) === final || null, 15_000)
    expect([...rejections(a), ...rejections(b)]).toEqual([])
  }, 90_000)
})

describe('sync server capacity limits', () => {
  // Two connections per address, so the third is refused.
  const server = syncProcess(BUSY_PORT, { SYNC_MAX_CONNECTIONS_PER_IP: '2' })

  beforeAll(async () => {
    await server.start()
  }, 60_000)

  afterAll(async () => {
    await server.stop()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('refuses a connection over the per-address cap as busy, not as an access denial, and lets it in once a slot frees up', async () => {
    const docs = await Promise.all([createDoc(), createDoc(), createDoc()])
    const [a, b] = [connect(server, docs[0]!.docId), connect(server, docs[1]!.docId)]
    await waitFor(() => a.syncs > 0 && b.syncs > 0)
    const c = connect(server, docs[2]!.docId)
    await waitFor(() => c.authFailures.length > 0)
    expect(c.authFailures).toEqual(['server-busy'])
    expect(c.syncs).toBe(0)
    a.provider.destroy()
    // What the editor does after a busy refusal: a new connection later.
    await sleep(300)
    c.provider.destroy()
    const retry = connect(server, docs[2]!.docId)
    await waitFor(() => retry.syncs > 0)
    expect(retry.authFailures).toEqual([])
  }, 60_000)
})

describe('per-document sync state in Valkey', () => {
  // A short grace period: the state goes when the document unloads.
  const graceMs = 1000
  const server = syncProcess(RESTART_PORT, { SYNC_UNLOAD_GRACE_MS: String(graceMs) })

  beforeAll(async () => {
    await server.start()
  }, 60_000)

  afterAll(async () => {
    await server.stop()
  })

  beforeEach(async () => {
    await resetDb()
  })

  async function storedRows(docId: string): Promise<number> {
    const r = await testDb().query<{ n: string }>('SELECT count(*) AS n FROM yjs_updates WHERE doc_id = $1', [docId])
    return Number(r.rows[0]?.n ?? 0)
  }

  async function stateKeys(docId: string): Promise<string[]> {
    const present: string[] = []
    for (const key of allSyncStateKeys(docId)) {
      if (await getValkeyKey(key) !== null) present.push(key)
    }
    return present
  }

  it('is gone once the last editor left, even when it left with an edit still to be stored', async () => {
    const doc = await createDoc()
    const editor = connect(server, doc.docId)
    await waitFor(() => editor.syncs > 0)
    // Seeded on load.
    await waitFor(async () => (await stateKeys(doc.docId)).length > 0 || null)
    editor.doc.getText('content').insert(0, 'leave right away')
    await sleep(200)
    // The store of this edit runs after the disconnect.
    editor.provider.destroy()
    // Watch the log, not a client: opening the document would seed it again.
    await waitFor(async () => (await storedRows(doc.docId)) > 0 || null)
    // Kept through the grace period (a reload would reuse it), then dropped.
    expect((await stateKeys(doc.docId)).length).toBeGreaterThan(0)
    await sleep(graceMs + 1_000)
    expect(await stateKeys(doc.docId)).toEqual([])
  }, 60_000)

  it('is deleted with the document, also when the sync server does not have it open', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    // State left behind by an earlier session (or another sync instance).
    for (const key of allSyncStateKeys(doc.docId)) await setValkeyKey(key, 'stale')
    const res = await (await loggedInClient(owner.id)).delete(`/api/docs/${doc.docId}`)
    expect(res.status).toBe(200)
    expect(await stateKeys(doc.docId)).toEqual([])
  })
})
