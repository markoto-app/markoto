import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import jwt from 'jsonwebtoken'
import WebSocket from 'ws'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { newProvider } from '../../helpers/hocuspocus'
import { resetDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createDoc, createUser } from '../setup/fixtures'
import { TEST_JWT_SECRET, TEST_SYNC_PORT } from '../setup/env'
import { SYNC_REAUTH_REASON } from '../../../shared/contracts/syncClose'

// An open sync connection must not outlive its authorization:
//   - the sync server closes a connection when its token expires and the
//     client doesn't hand over a fresh one (connection-expiry.ts), and
//     renews it in place when the client does;
//   - when the owner makes a document stricter, the app tells the sync
//     server to close the document's connections and to refuse tokens
//     issued before the change (`/internal/reauth-document`).
// Against the real sync-test container + the app test server.

const WS_URL = `ws://127.0.0.1:${TEST_SYNC_PORT}`
// connection-expiry.ts: TOKEN_RENEW_LEAD_MS / TOKEN_EXPIRY_GRACE_MS.
const RENEW_LEAD_S = 45
const GRACE_MS = 5_000

interface Client {
  provider: HocuspocusProvider
  doc: Y.Doc
  closes: Array<{ code: number, reason: string }>
  syncs: number
  authFailures: string[]
  tokenCalls: number
}

const open: Client[] = []

function connect(docId: string, token: string | (() => string | Promise<string>)): Client {
  const doc = new Y.Doc()
  const client: Client = { provider: null as unknown as HocuspocusProvider, doc, closes: [], syncs: 0, authFailures: [], tokenCalls: 0 }
  client.provider = newProvider({
    url: WS_URL,
    name: docId,
    document: doc,
    token: async () => {
      client.tokenCalls++
      return typeof token === 'function' ? await token() : token
    },
    WebSocketPolyfill: WebSocket,
    onSynced: () => {
      client.syncs++
    },
    onAuthenticationFailed: ({ reason }) => {
      client.authFailures.push(reason)
    },
    onClose: ({ event }) => {
      client.closes.push({ code: event.code, reason: event.reason })
    }
  })
  open.push(client)
  return client
}

function mint(docId: string, userId: string | number, expiresIn: number): string {
  return jwt.sign({ docId, userId, userName: null, readOnly: false }, TEST_JWT_SECRET, { expiresIn })
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

const reauthClosed = (c: Client) => c.closes.some(e => e.reason === SYNC_REAUTH_REASON)

beforeEach(async () => {
  await resetDb()
})

afterEach(() => {
  for (const c of open.splice(0)) {
    c.provider.destroy()
    c.doc.destroy()
  }
})

describe('token expiry on an open connection', () => {
  it('closes the connection for re-authentication once its token expires without renewal', async () => {
    const doc = await createDoc({ accessMode: 'open-edit' })
    // Static token: the client can only hand back the same one.
    const c = connect(doc.docId, mint(doc.docId, 'anonymous', 3))
    await waitFor(() => c.syncs > 0)
    const start = Date.now()
    await waitFor(() => reauthClosed(c), 3_000 + GRACE_MS + 5_000)
    expect(Date.now() - start).toBeGreaterThan(1_000)
  }, 20_000)

  it('asks for a fresh token before expiry and keeps a renewed connection open', async () => {
    const doc = await createDoc({ accessMode: 'open-edit' })
    let first = true
    const c = connect(doc.docId, () => {
      // First connect: a token that enters the renewal window in ~2 s.
      // Renewal: a full-length one.
      const token = mint(doc.docId, 'anonymous', first ? RENEW_LEAD_S + 2 : 7200)
      first = false
      return token
    })
    await waitFor(() => c.syncs > 0)
    await waitFor(() => c.tokenCalls >= 2, 10_000)
    // Renewed in place: no close, no second handshake.
    await new Promise(r => setTimeout(r, 1_000))
    expect(c.closes).toEqual([])
    expect(c.syncs).toBe(1)
  }, 20_000)
})

describe('document made stricter while visitors are connected', () => {
  it('disconnects the visitor after the owner makes the document private; the old token no longer opens it', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
    const ownerClient = await loggedInClient(owner.id)

    const visitorRes = await anonClient().get(`/api/docs/${doc.docId}/token`)
    const visitorToken = (await visitorRes.json() as { token: string }).token
    expect(visitorToken).toBeTruthy()
    const visitor = connect(doc.docId, visitorToken)

    // The owner's editor fetches its token from the app on every connect,
    // like the real editor does after a re-authenticate close.
    const ownerEditor = connect(doc.docId, async () => {
      const res = await ownerClient.get(`/api/docs/${doc.docId}/token?refresh=1`)
      return (await res.json() as { token: string }).token
    })
    await waitFor(() => visitor.syncs > 0 && ownerEditor.syncs > 0)
    // The cutoff has one-second resolution (JWT `iat`): let the visitor's
    // token fall into an earlier second than the change.
    await new Promise(r => setTimeout(r, 1_100))

    const put = await ownerClient.put(`/api/docs/${doc.docId}/meta`, { accessMode: 'private' })
    expect(put.status).toBe(200)

    await waitFor(() => reauthClosed(visitor))
    // The visitor's own reconnect presents its old token and is refused.
    await waitFor(() => visitor.authFailures.length > 0)

    // The app no longer issues the visitor a token…
    const denied = await (await anonClient().get(`/api/docs/${doc.docId}/token`)).json() as { token: string | null, forbidden: boolean }
    expect(denied).toMatchObject({ token: null, forbidden: true })
    // …and a fresh connection with the token minted before the change is refused.
    const replay = connect(doc.docId, visitorToken)
    await waitFor(() => replay.authFailures.length > 0)
    expect(replay.syncs).toBe(0)

    // The owner was closed too and is back with a fresh token.
    await waitFor(() => reauthClosed(ownerEditor))
    await waitFor(() => ownerEditor.syncs >= 2)
    expect(ownerEditor.authFailures).toEqual([])
  }, 30_000)

  it('leaves connections alone when access only gets wider', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-view' })
    const ownerClient = await loggedInClient(owner.id)
    const visitorToken = (await (await anonClient().get(`/api/docs/${doc.docId}/token`)).json() as { token: string }).token
    const visitor = connect(doc.docId, visitorToken)
    await waitFor(() => visitor.syncs > 0)

    expect((await ownerClient.put(`/api/docs/${doc.docId}/meta`, { accessMode: 'open-edit' })).status).toBe(200)
    await new Promise(r => setTimeout(r, 1_500))
    expect(visitor.closes).toEqual([])
  }, 20_000)
})
