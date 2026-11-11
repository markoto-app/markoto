import * as Y from 'yjs'
import jwt from 'jsonwebtoken'
import WebSocket from 'ws'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { newProvider } from '../../helpers/hocuspocus'
import { Awareness } from 'y-protocols/awareness'
import { testDb } from './db'
import { createUser, type TestUser } from './fixtures'
import { TEST_FAKE_OPENAI_HOST_URL, TEST_JWT_SECRET, TEST_SYNC_PORT } from './env'
import { buildTestEnv } from './testEnv'
import { encryptToken } from '../../../server/utils/litellm/tokenCrypto'

// Shared helpers for tests that drive the real AI loop against the
// `fake-openai-test` provider (tests/fixtures/fake-openai/server.py)
// through `litellm-test`, plus a minimal Hocuspocus client for writing
// document content / watching awareness as a given identity.

export const LITELLM_URL = 'http://127.0.0.1:4100'
export const LITELLM_MASTER_KEY = 'sk-test-litellm-master'
// Same salt as the server subprocess, so the token we store decrypts there.
process.env.LITELLM_SALT_KEY = buildTestEnv().LITELLM_SALT_KEY

export interface FakeRequest {
  path: string
  model: string
  keySuffix: string
  tools?: string[]
  /** Tool-result messages the model received in that request. */
  toolResults?: string[]
  /** Images (`image_url` parts) the request carried. */
  images?: number
}

export async function fakeRequests(): Promise<FakeRequest[]> {
  const res = await fetch(`${TEST_FAKE_OPENAI_HOST_URL}/_test/requests`)
  const body: { requests: FakeRequest[] } = await res.json()
  return body.requests
}

export async function resetFake(): Promise<void> {
  await fetch(`${TEST_FAKE_OPENAI_HOST_URL}/_test/reset`, { method: 'POST', body: '{}' })
}

export function uniqueKey(label: string): string {
  return `sk-byok-${label}-${Math.random().toString(36).slice(2, 10)}`
}

export async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== null) return value
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * The integration server runs with `LITELLM_TEST_STUB=1` (shared test
 * env), so users would otherwise get the stub virtual key, which the real
 * `litellm-test` proxy rejects. BYOK calls must authenticate with a REAL
 * virtual key, so provision one through the proxy's admin API and store
 * it exactly like `createUserKey` does (encrypted token + key id).
 */
async function provisionVirtualKey(userId: number): Promise<void> {
  const res = await fetch(`${LITELLM_URL}/key/generate`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${LITELLM_MASTER_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_budget: 1, user_id: String(userId), rpm_limit: 600, metadata: { allow_client_tags: true } })
  })
  if (!res.ok) throw new Error(`/key/generate failed: ${res.status} ${await res.text()}`)
  const body: { key: string, token_id?: string, token?: string } = await res.json()
  await testDb().query(
    'UPDATE users SET litellm_key_id = $1, litellm_key_token = $2 WHERE id = $3',
    [body.token_id ?? body.token, encryptToken(body.key), userId]
  )
}

export async function byokUser(name?: string): Promise<TestUser> {
  const u = await createUser(name ? { name } : {})
  await provisionVirtualKey(u.id)
  return u
}

// Hocuspocus test client

export interface SyncIdentity {
  userId: string
  userName: string | null
  readOnly?: boolean
}

export interface SyncClient {
  doc: Y.Doc
  awareness: Awareness
  provider: HocuspocusProvider
  synced: Promise<void>
  destroy(): void
}

/** Connect to the sync-test container as `identity` (JWT minted like `/api/docs/:id/token`). */
export function connectSync(docId: string, identity: SyncIdentity): SyncClient {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  let resolveSynced: () => void = () => {}
  let rejectSynced: (e: Error) => void = () => {}
  const synced = new Promise<void>((resolve, reject) => {
    resolveSynced = resolve
    rejectSynced = reject
  })
  const token = jwt.sign(
    { docId, userId: identity.userId, userName: identity.userName, readOnly: identity.readOnly ?? false },
    TEST_JWT_SECRET,
    { expiresIn: '10m' }
  )
  const provider = newProvider({
    url: `ws://127.0.0.1:${TEST_SYNC_PORT}`,
    name: docId,
    document: doc,
    awareness,
    token,
    WebSocketPolyfill: WebSocket,
    onSynced: () => resolveSynced(),
    onAuthenticationFailed: ({ reason }) => rejectSynced(new Error(`auth failed: ${reason}`))
  })
  return {
    doc,
    awareness,
    provider,
    synced,
    destroy() {
      provider.destroy()
      doc.destroy()
    }
  }
}

/** Write `text` into the document body as `identity`; the client stays connected (caller destroys). */
export async function writeDocAs(docId: string, identity: SyncIdentity, text: string): Promise<SyncClient> {
  const c = connectSync(docId, identity)
  await c.synced
  c.doc.transact(() => {
    const ytext = c.doc.getText('content')
    ytext.insert(ytext.length, text)
  })
  await waitForAcked(c)
  return c
}

/** Resolve once the server acknowledged every local change of `c`. */
export async function waitForAcked(c: SyncClient): Promise<void> {
  await waitFor(async () => (c.provider.hasUnsyncedChanges ? null : true), 10_000, 'the sync server to acknowledge the edit')
}
