// BYOK redirect SSRF (regression). The app checks a user's provider base
// URL (and its DNS answers) before every call, but the request itself is
// made by LiteLLM — whose OpenAI client used to FOLLOW redirects. A
// provider host that passes the check could answer 302/307 and make the
// proxy fetch an internal service the check never saw; the internal
// response then came back in the error text (or, for transcription, as
// the transcript).
//
//   app → litellm-test (`byok/*`) → fake-openai-test `/redirect/<status>/<port>/…`
//                                     └─ Location: http://<bridge>:<port>/canary/…
//
// The canary listens in this test process on the docker bridge side (like
// the fake provider). It must never be hit through a redirect. A positive
// control proves litellm-test CAN reach the canary directly, so "no hits"
// means "not followed", not "not reachable".
//
// Test stack required: postgres-test + valkey-test + litellm-test +
// fake-openai-test (docker-compose.test.yml).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createUser } from '../setup/fixtures'
import { TEST_FAKE_OPENAI_HOST_URL, fakeOpenAiBaseUrl } from '../setup/env'
import { buildTestEnv } from '../setup/testEnv'
import { encryptToken } from '../../../server/utils/litellm/tokenCrypto'

const LITELLM_URL = 'http://127.0.0.1:4100'
const LITELLM_MASTER_KEY = 'sk-test-litellm-master'
const CANARY_BODY = 'CANARY-INTERNAL-BODY'
// Same salt as the server subprocess, so the token we store decrypts there.
process.env.LITELLM_SALT_KEY = buildTestEnv().LITELLM_SALT_KEY

const FAKE_ORIGIN = new URL(fakeOpenAiBaseUrl()).origin
const BRIDGE_HOST = new URL(fakeOpenAiBaseUrl()).hostname

let canary: Server
let canaryPort = 0
const canaryHits: string[] = []

beforeAll(async () => {
  canary = createServer((req, res) => {
    canaryHits.push(`${req.method} ${req.url}`)
    req.resume()
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': CANARY_BODY.length })
    res.end(CANARY_BODY)
  })
  await new Promise<void>((resolve, reject) => {
    canary.once('error', reject)
    canary.listen(0, '0.0.0.0', () => resolve())
  })
  const addr = canary.address()
  if (!addr || typeof addr === 'string') throw new Error('canary has no TCP address')
  canaryPort = (addr as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>(r => canary.close(() => r()))
})

beforeEach(async () => {
  await resetDb()
  await fetch(`${TEST_FAKE_OPENAI_HOST_URL}/_test/reset`, { method: 'POST', body: '{}' })
  canaryHits.length = 0
})

/** Real virtual key (BYOK calls go through the real litellm-test proxy). */
async function byokUser(): Promise<number> {
  const u = await createUser()
  const res = await fetch(`${LITELLM_URL}/key/generate`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${LITELLM_MASTER_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_budget: 1, user_id: String(u.id), rpm_limit: 600, metadata: { allow_client_tags: true } })
  })
  if (!res.ok) throw new Error(`/key/generate failed: ${res.status} ${await res.text()}`)
  const body: { key: string, token_id?: string, token?: string } = await res.json()
  await testDb().query(
    'UPDATE users SET litellm_key_id = $1, litellm_key_token = $2 WHERE id = $3',
    [body.token_id ?? body.token, encryptToken(body.key), u.id]
  )
  return u.id
}

async function fakeSawRedirect(): Promise<boolean> {
  const res = await fetch(`${TEST_FAKE_OPENAI_HOST_URL}/_test/requests`)
  const body: { requests: Array<{ path: string }> } = await res.json()
  return body.requests.some(r => r.path.startsWith('/redirect/'))
}

const key = () => `sk-byok-redirect-${Math.random().toString(36).slice(2, 10)}`

describe('BYOK provider redirects are not followed by the proxy', () => {
  it('positive control: litellm-test can reach the canary directly', async () => {
    const client = await loggedInClient(await byokUser())
    await client.put('/api/user/ai-providers/chat', {
      baseUrl: `http://${BRIDGE_HOST}:${canaryPort}/canary/v1`,
      model: 'fake-chat',
      apiKey: key()
    })
    expect(canaryHits.length).toBeGreaterThan(0)
  }, 60_000)

  it.each([
    ['chat', 302],
    ['chat', 307],
    ['transcription', 302],
    ['transcription', 307]
  ])('%s verification through a %s redirect never reaches the redirect target', async (capability, status) => {
    const client = await loggedInClient(await byokUser())
    const res = await client.put(`/api/user/ai-providers/${capability}`, {
      baseUrl: `${FAKE_ORIGIN}/redirect/${status}/${canaryPort}/v1`,
      model: capability === 'chat' ? 'fake-chat' : 'fake-whisper',
      apiKey: key()
    })
    const text = await res.text()
    // The provider was contacted (and answered with the redirect)…
    expect(await fakeSawRedirect()).toBe(true)
    // …but the redirect target never was, and nothing of it leaks back.
    expect(canaryHits).toEqual([])
    expect(res.status, text).toBe(422)
    expect(text).not.toContain(CANARY_BODY)
    const body: { data?: { reason?: string } } = JSON.parse(text)
    expect(body.data?.reason).toBe('unexpected-response')
    expect(text).toMatch(/redirect/i)
  }, 60_000)
})
