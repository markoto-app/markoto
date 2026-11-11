import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import jwt from 'jsonwebtoken'
import WebSocket from 'ws'
import * as encoding from 'lib0/encoding'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Awareness } from 'y-protocols/awareness'
import { ensureYjsTable, resetDb, testDb } from '../setup/db'
import { createDoc, createUser } from '../setup/fixtures'
import { TEST_JWT_SECRET, TEST_SYNC_URL, TEST_SYNC_PORT } from '../setup/env'
import { defaultTheme } from '../../../shared/utils/theme/defaultTheme'

// End-to-end hardening of the real sync-test container (Hocuspocus):
//   - failed handshakes must not leak per-IP connection slots,
//   - oversized frames / updates / documents are refused with a reason,
//   - ymeta writes are validated on the WebSocket path, and a document
//     with an already-corrupted theme still loads,
//   - awareness `user` fields are normalised before they are relayed,
//   - anonymous edits are not attributed to a client-chosen name,
//   - messages queued before authentication are bounded (bytes + time),
//   - read-only connections can't broadcast stateless messages.
//
// The size limits come from docker-compose.test.yml (sync-test env) and
// MUST match the constants below.
const MAX_MESSAGE_BYTES = 1_572_864
const MAX_UPDATE_BYTES = 1_048_576
const MAX_DOCUMENT_BYTES = 2_097_152
const MAX_PREAUTH_BYTES = 4_194_304
const AUTH_TIMEOUT_MS = 3000

const WS_URL = `ws://127.0.0.1:${TEST_SYNC_PORT}`

interface Identity {
  userId: string
  userName: string | null
  readOnly?: boolean
}

function mintToken(docId: string, identity: Identity): string {
  return jwt.sign(
    { docId, userId: identity.userId, userName: identity.userName, readOnly: identity.readOnly ?? false },
    TEST_JWT_SECRET,
    { expiresIn: '10m' }
  )
}

interface Client {
  doc: Y.Doc
  awareness: Awareness
  provider: HocuspocusProvider
  closes: Array<{ code: number, reason: string }>
  stateless: string[]
  synced: Promise<void>
}

const openClients: Client[] = []

function connect(docId: string, identity: Identity): Client {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  const closes: Array<{ code: number, reason: string }> = []
  const stateless: string[] = []
  let resolveSynced: () => void = () => {}
  let rejectSynced: (e: Error) => void = () => {}
  const synced = new Promise<void>((resolve, reject) => {
    resolveSynced = resolve
    rejectSynced = reject
  })
  const provider = new HocuspocusProvider({
    url: WS_URL,
    name: docId,
    document: doc,
    awareness,
    token: mintToken(docId, identity),
    WebSocketPolyfill: WebSocket,
    onSynced: () => resolveSynced(),
    onAuthenticationFailed: ({ reason }) => rejectSynced(new Error(`auth failed: ${reason}`)),
    onClose: ({ event }) => {
      closes.push({ code: event.code, reason: event.reason })
    },
    onStateless: ({ payload }) => {
      stateless.push(payload)
    }
  })
  const client = { doc, awareness, provider, closes, stateless, synced }
  openClients.push(client)
  return client
}

async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs = 15_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = probe()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`)
    await new Promise(r => setTimeout(r, 50))
  }
}

async function waitForAsync<T>(probe: () => Promise<T | null | undefined>, timeoutMs = 20_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await probe()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`waitForAsync timed out after ${timeoutMs}ms`)
    await new Promise(r => setTimeout(r, 200))
  }
}

/** Load the doc as a fresh client and return it once synced. */
async function freshCopy(docId: string): Promise<Y.Doc> {
  const c = connect(docId, { userId: 'anonymous', userName: null, readOnly: true })
  await c.synced
  return c.doc
}

beforeEach(async () => {
  await resetDb()
  await ensureYjsTable()
})

afterEach(() => {
  for (const c of openClients.splice(0)) {
    c.provider.destroy()
    c.doc.destroy()
  }
})

describe('per-IP connection slots (failed handshakes)', () => {
  /** Raw WS that authenticates with a garbage token, waits for the denial, closes. */
  function failedHandshake(docId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL)
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new Error('no auth reply'))
      }, 5000)
      ws.on('open', () => {
        const enc = encoding.createEncoder()
        encoding.writeVarString(enc, docId)
        encoding.writeVarUint(enc, 2) // Auth
        encoding.writeVarUint(enc, 0) // Token
        encoding.writeVarString(enc, 'garbage.token.value')
        ws.send(encoding.toUint8Array(enc))
      })
      ws.on('message', () => {
        clearTimeout(timer)
        ws.close()
      })
      ws.on('close', () => resolve())
      ws.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })
  }

  it('a flood of failed handshakes beyond the per-IP cap does not lock the IP out', async () => {
    const doc = await createDoc()
    // The test container runs with the non-production default cap (200).
    const attempts = 230
    for (let i = 0; i < attempts; i += 23) {
      await Promise.all(Array.from({ length: 23 }, () => failedHandshake(doc.docId)))
    }
    const client = connect(doc.docId, { userId: 'anonymous', userName: null })
    await expect(client.synced).resolves.toBeUndefined()
  }, 60_000)
})

describe('size limits', () => {
  it('rejects an update that would grow the document past SYNC_MAX_DOCUMENT_BYTES', async () => {
    const doc = await createDoc()
    const client = connect(doc.docId, { userId: 'anonymous', userName: null })
    await client.synced
    const chunk = 'a'.repeat(Math.floor(MAX_UPDATE_BYTES * 0.8))
    const text = client.doc.getText('content')
    text.insert(0, chunk)
    text.insert(0, chunk)
    text.insert(0, chunk) // pushes the doc past MAX_DOCUMENT_BYTES
    const close = await waitFor(() => client.closes.find(c => c.reason === 'document-too-large'))
    expect(close).toBeTruthy()

    const copy = await freshCopy(doc.docId)
    expect(copy.getText('content').length).toBe(chunk.length * 2)
    expect(Y.encodeStateAsUpdate(copy).byteLength).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES)
  })

  it('rejects a single update above SYNC_MAX_UPDATE_BYTES', async () => {
    const doc = await createDoc()
    const client = connect(doc.docId, { userId: 'anonymous', userName: null })
    await client.synced
    client.doc.getText('content').insert(0, 'b'.repeat(MAX_UPDATE_BYTES + 50_000))
    await waitFor(() => client.closes.find(c => c.reason === 'update-too-large'))
    const copy = await freshCopy(doc.docId)
    expect(copy.getText('content').length).toBe(0)
  })

  it('refuses a WebSocket frame above SYNC_MAX_MESSAGE_BYTES (close 1009) and stays healthy', async () => {
    const doc = await createDoc()
    const client = connect(doc.docId, { userId: 'anonymous', userName: null })
    await client.synced
    client.doc.getText('content').insert(0, 'c'.repeat(MAX_MESSAGE_BYTES + 100_000))
    await waitFor(() => client.closes.find(c => c.code === 1009))
    const health = await fetch(`${TEST_SYNC_URL}/health`)
    expect(health.ok).toBe(true)
  })
})

describe('ymeta validation on the WebSocket path', () => {
  it('rejects a deeply nested theme and leaves the document loadable', async () => {
    const doc = await createDoc()
    const client = connect(doc.docId, { userId: 'anonymous', userName: null })
    await client.synced
    client.doc.getMap('meta').set('title', 'Kept')
    await new Promise(r => setTimeout(r, 300))
    client.doc.transact(() => {
      let cur = new Y.Map<unknown>()
      client.doc.getMap('meta').set('theme', cur)
      for (let i = 0; i < 2000; i++) {
        const next = new Y.Map<unknown>()
        cur.set('n', next)
        cur = next
      }
    })
    await waitFor(() => client.closes.find(c => c.reason === 'invalid-meta'))

    const copy = await freshCopy(doc.docId)
    expect(copy.getMap('meta').get('title')).toBe('Kept')
    expect(copy.getMap('meta').get('theme')).toBeUndefined()
  })

  it('rejects an invalid title and accepts a valid theme', async () => {
    const doc = await createDoc()
    const good = connect(doc.docId, { userId: 'anonymous', userName: null })
    await good.synced
    good.doc.getMap('meta').set('theme', defaultTheme)
    await new Promise(r => setTimeout(r, 300))
    expect(good.closes).toHaveLength(0)

    const bad = connect(doc.docId, { userId: 'anonymous', userName: null })
    await bad.synced
    bad.doc.getMap('meta').set('title', 'x'.repeat(300))
    await waitFor(() => bad.closes.find(c => c.reason === 'invalid-meta'))
  })

  it('loads a document whose stored theme is already corrupted (deep nested Y.Map) and accepts edits', async () => {
    const doc = await createDoc()
    // State written before the WebSocket path validated ymeta: a theme
    // nested deep enough to overflow a recursive JSON.stringify.
    const corrupt = new Y.Doc()
    corrupt.transact(() => {
      corrupt.getText('content').insert(0, 'still here')
      let cur = new Y.Map<unknown>()
      corrupt.getMap('meta').set('theme', cur)
      for (let i = 0; i < 30_000; i++) {
        const next = new Y.Map<unknown>()
        cur.set('n', next)
        cur = next
      }
    })
    const update = Y.encodeStateAsUpdate(corrupt)
    await testDb().query(
      `INSERT INTO yjs_documents (docname, value, version) VALUES ($1, $2, 'v1')`,
      [doc.docId, Buffer.from(update.buffer, update.byteOffset, update.byteLength)]
    )

    const client = connect(doc.docId, { userId: 'anonymous', userName: null })
    await client.synced
    expect(client.doc.getText('content').toJSON()).toBe('still here')
    client.doc.getText('content').insert(0, 'and editable: ')
    await new Promise(r => setTimeout(r, 500))
    expect(client.closes).toHaveLength(0)
  }, 30_000)
})

describe('awareness user normalisation', () => {
  it('relays a normalised user to other clients', async () => {
    const doc = await createDoc()
    const sender = connect(doc.docId, { userId: 'anonymous', userName: null })
    const receiver = connect(doc.docId, { userId: 'anonymous', userName: null })
    await Promise.all([sender.synced, receiver.synced])
    sender.awareness.setLocalStateField('user', {
      name: 'n'.repeat(500),
      color: 'red; position: fixed; inset: 0',
      avatar: 'javascript:alert(1)',
      id: 'not-a-number',
      extra: 'dropped'
    })
    const user = await waitFor(() => receiver.awareness.getStates().get(sender.doc.clientID)?.user)
    expect(user).toEqual({ name: 'n'.repeat(64), color: '#7E8B9A' })
  })
})

describe('activity-log attribution', () => {
  async function editRow(docId: string): Promise<{ user_name: string | null, actor_principal: string | null }> {
    return waitForAsync(async () => {
      const r = await testDb().query<{ user_name: string | null, actor_principal: string | null }>(
        `SELECT user_name, actor_principal FROM activity_log WHERE doc_id = $1 AND action = 'edit' ORDER BY id DESC LIMIT 1`,
        [docId]
      )
      return r.rows[0]
    })
  }

  it('does not attribute an anonymous edit to the name the client put in awareness', async () => {
    const doc = await createDoc()
    const client = connect(doc.docId, { userId: 'anonymous', userName: null })
    await client.synced
    client.awareness.setLocalStateField('user', { name: 'CEO Bob (forged)', color: '#7A8C7E' })
    await new Promise(r => setTimeout(r, 200))
    client.doc.getText('content').insert(0, 'line one\nline two\n')
    const row = await editRow(doc.docId)
    expect(row.user_name).toBeNull()
    expect(row.actor_principal).toBe('anonymous')
  }, 30_000)

  it('keeps the JWT name for a logged-in editor', async () => {
    const user = await createUser({ name: 'Real User' })
    const doc = await createDoc({ ownerId: user.id, accessMode: 'open-edit' })
    const client = connect(doc.docId, { userId: String(user.id), userName: 'Real User' })
    await client.synced
    client.awareness.setLocalStateField('user', { name: 'Someone Else', color: '#7A8C7E' })
    client.doc.getText('content').insert(0, 'hello\nworld\n')
    const row = await editRow(doc.docId)
    expect(row.user_name).toBe('Real User')
  }, 30_000)
})

/** varString(doc) varUint(type) …payload — a raw Hocuspocus frame. */
function rawFrame(docId: string, type: number, write: (enc: encoding.Encoder) => void): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarString(enc, docId)
  encoding.writeVarUint(enc, type)
  write(enc)
  return encoding.toUint8Array(enc)
}

/** A raw socket that never authenticates; resolves with its close event. */
function openUnauthenticated(onOpen: (ws: WebSocket) => void): Promise<{ code: number, reason: string, elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    const started = Date.now()
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('socket was not closed by the server'))
    }, 20_000)
    ws.on('open', () => onOpen(ws))
    ws.on('close', (code, reason) => {
      clearTimeout(timer)
      resolve({ code, reason: reason.toString(), elapsedMs: Date.now() - started })
    })
    ws.on('error', () => { /* the close event follows */ })
  })
}

describe('messages queued before authentication', () => {
  it('closes a socket that queues more than SYNC_MAX_PREAUTH_BYTES without authenticating', async () => {
    const doc = await createDoc()
    const chunk = 512 * 1024
    const close = await openUnauthenticated((ws) => {
      // Sync updates for a document that never sends its Auth frame —
      // Hocuspocus would queue them all.
      for (let sent = 0; sent <= MAX_PREAUTH_BYTES + chunk; sent += chunk) {
        ws.send(rawFrame(doc.docId, 0, (enc) => {
          encoding.writeVarUint(enc, 2)
          encoding.writeVarUint8Array(enc, new Uint8Array(chunk))
        }))
      }
    })
    expect(close.code).toBe(4413)
    expect(close.reason).toBe('update-too-large')
    expect(close.elapsedMs).toBeLessThan(AUTH_TIMEOUT_MS)
    // The server is fine and still serves real clients.
    const client = connect(doc.docId, { userId: 'anonymous', userName: null })
    await expect(client.synced).resolves.toBeUndefined()
  }, 30_000)

  it('closes a socket whose document never sends its Auth frame within SYNC_AUTH_TIMEOUT_MS', async () => {
    const doc = await createDoc()
    const close = await openUnauthenticated((ws) => {
      ws.send(rawFrame(doc.docId, 1, enc => encoding.writeVarUint8Array(enc, new Uint8Array([0]))))
    })
    expect(close.code).toBe(4408)
    expect(close.reason).toBe('auth-timeout')
    expect(close.elapsedMs).toBeGreaterThanOrEqual(AUTH_TIMEOUT_MS - 200)
  }, 30_000)

  it('leaves normal clients alone (auth frame first, then sync)', async () => {
    const doc = await createDoc()
    const client = connect(doc.docId, { userId: 'anonymous', userName: null })
    await client.synced
    client.doc.getText('content').insert(0, 'x'.repeat(200_000))
    await new Promise(r => setTimeout(r, AUTH_TIMEOUT_MS + 500))
    expect(client.closes).toEqual([])
  }, 30_000)
})

describe('stateless messages', () => {
  function broadcastStateless(c: Client, payload: string): void {
    c.provider.configuration.websocketProvider.send(rawFrame(c.provider.configuration.name, 6, enc => encoding.writeVarString(enc, payload)))
  }

  it('a writer\'s broadcast reaches the other clients (positive control)', async () => {
    const doc = await createDoc()
    const writer = connect(doc.docId, { userId: 'anonymous', userName: null })
    const viewer = connect(doc.docId, { userId: 'anonymous', userName: null, readOnly: true })
    await Promise.all([writer.synced, viewer.synced])
    broadcastStateless(writer, 'from-writer')
    await waitFor(() => viewer.stateless.includes('from-writer'))
  })

  it('a read-only connection\'s broadcast is dropped and its connection closed', async () => {
    const doc = await createDoc()
    const writer = connect(doc.docId, { userId: 'anonymous', userName: null })
    const viewer = connect(doc.docId, { userId: 'anonymous', userName: null, readOnly: true })
    await Promise.all([writer.synced, viewer.synced])
    broadcastStateless(viewer, 'from-viewer')
    await waitFor(() => viewer.closes.find(c => c.reason === 'invalid-update'))
    // Give a relay time to arrive if it were going to.
    broadcastStateless(writer, 'marker')
    await waitFor(() => writer.stateless.includes('marker'))
    expect(writer.stateless).not.toContain('from-viewer')
  })
})
