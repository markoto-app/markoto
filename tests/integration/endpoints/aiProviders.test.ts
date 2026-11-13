import { describe, it, expect, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { Pool } from 'pg'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient, type TestClient } from '../setup/client'
import { createDoc } from '../setup/fixtures'
import { TEST_BILLING_OFF_BASE_URL, fakeOpenAiBaseUrl } from '../setup/env'
import { LITELLM_MASTER_KEY, LITELLM_URL, byokUser, fakeRequests, resetFake, uniqueKey, waitFor } from '../setup/byok'
import { openSecret, secretContext } from '../../../server/utils/platform/secretBox'

// Bring-your-own-key AI providers, end to end:
//   app (SSRF policy, encryption, verification) → litellm-test (`byok/*`
//   clientside credentials, zero cost) → fake-openai-test (the "user's
//   provider", tests/fixtures/fake-openai/server.py).
//
// Server shapes (tests/integration/setup/server.ts):
//   - primary (TEST_BASE_URL)   = SELF-HOSTED: Mistral/BFL/Voxtral model-
//     alias instance defaults, free-form URLs, private networks allowed
//     (that's how the fake provider on the docker bridge is reachable).
//   - billing-off twin          = HOSTED SaaS: no instance defaults,
//     provider allowlist, no private networks.

const FAKE = fakeOpenAiBaseUrl()
const DOC_MARKER = 'BYOK fake provider says hello.'
const TRANSCRIPT = 'hello from the fake transcription provider'
const LITELLM_DB_URL = process.env.NUXT_LITELLM_DB_URL ?? 'postgres://ypad:testpassword@localhost:5433/litellm_test'

async function readYtext(docname: string): Promise<string> {
  const r = await testDb().query<{ value: Buffer }>(
    // Only update rows: y-postgresql also stores state-vector rows
    // (`version = 'v1_sv'`), which are not Y.js updates.
    `SELECT data AS value FROM yjs_updates WHERE doc_id = $1 ORDER BY id`,
    [docname]
  )
  const ydoc = new Y.Doc()
  for (const row of r.rows) Y.applyUpdate(ydoc, new Uint8Array(row.value))
  return ydoc.getText('content').toString()
}

async function saveProvider(client: TestClient, capability: string, body: Record<string, unknown>): Promise<Response> {
  return client.put(`/api/user/ai-providers/${capability}`, body)
}

interface ErrorBody { data?: { code?: string, reason?: string } }

async function refusalReason(res: Response): Promise<string | undefined> {
  const body: ErrorBody = await res.json()
  return body.data?.reason
}

describe('BYOK provider settings (self-hosted shape)', () => {
  beforeEach(async () => {
    await resetDb()
    await resetFake()
  })

  it('requires login', async () => {
    expect((await anonClient().get('/api/user/ai-providers')).status).toBe(401)
    expect((await anonClient().put('/api/user/ai-providers/chat', { baseUrl: FAKE, model: 'fake-chat', apiKey: 'x' })).status).toBe(401)
    expect((await anonClient().get('/api/ai/availability')).status).toBe(401)
  })

  it('saves a chat provider after a tool-calling probe through LiteLLM, and never returns the key', async () => {
    const u = await byokUser()
    const client = await loggedInClient(u.id)
    const key = uniqueKey('chat')

    const res = await saveProvider(client, 'chat', { baseUrl: `${FAKE}/`, model: 'fake-chat', apiKey: key, supportsVision: false })
    const text = await res.text()
    expect(res.status, text).toBe(200)
    expect(text).not.toContain(key)
    const body: { provider: { baseUrl: string, apiKeyLast4: string, model: string }, verify: { code: string } } = JSON.parse(text)
    expect(body.verify.code).toBe('ok')
    expect(body.provider.baseUrl).toBe(FAKE)
    expect(body.provider.apiKeyLast4).toBe(key.slice(-4))

    // The probe reached the fake provider WITH the user's key and a tool definition.
    const calls = (await fakeRequests()).filter(r => r.keySuffix === key.slice(-6))
    expect(calls.some(c => c.path.startsWith('/v1/chat/completions') && c.tools?.includes('report_status'))).toBe(true)

    // Listing + availability never include the key either.
    const listText = await (await client.get('/api/user/ai-providers')).text()
    expect(listText).not.toContain(key)
    const avail: { chat: { source: string, platformBilled: boolean } } = await (await client.get('/api/ai/availability')).json()
    expect(avail.chat).toMatchObject({ source: 'user', platformBilled: false })

    // Stored encrypted; the audit row names the host, not the key.
    const stored = await testDb().query<{ api_key_encrypted: string }>('SELECT api_key_encrypted FROM user_ai_providers WHERE user_id = $1', [u.id])
    expect(stored.rows[0]?.api_key_encrypted).not.toContain(key)
    const audit = await testDb().query<{ metadata: unknown }>(`SELECT metadata FROM audit_log WHERE action = 'ai_provider.saved' AND scope_id = $1`, [String(u.id)])
    expect(audit.rows).toHaveLength(1)
    expect(JSON.stringify(audit.rows[0]?.metadata)).not.toContain(key.slice(-4))
  })

  it('saves with a warning when the model does not call tools', async () => {
    const u = await byokUser()
    const client = await loggedInClient(u.id)
    const res = await saveProvider(client, 'chat', { baseUrl: FAKE, model: 'no-tools-model', apiKey: uniqueKey('notools') })
    expect(res.status).toBe(200)
    const body: { verify: { code: string }, provider: { model: string } } = await res.json()
    expect(body.verify.code).toBe('no-tool-support')
  })

  it('refuses (and does not save) a rejected key or an unknown model, with a key-free message', async () => {
    const u = await byokUser()
    const client = await loggedInClient(u.id)

    const bad = await saveProvider(client, 'chat', { baseUrl: FAKE, model: 'fake-chat', apiKey: 'bad-key' })
    expect(bad.status).toBe(422)
    const badText = await bad.text()
    expect(badText).not.toContain('bad-key')
    const badBody: ErrorBody = JSON.parse(badText)
    expect(badBody.data?.reason).toBe('auth-failed')

    const missing = await saveProvider(client, 'chat', { baseUrl: FAKE, model: 'missing-model', apiKey: uniqueKey('missing') })
    expect(missing.status).toBe(422)
    expect(await refusalReason(missing)).toBe('model-not-found')

    const rows = await testDb().query('SELECT 1 FROM user_ai_providers WHERE user_id = $1', [u.id])
    expect(rows.rowCount).toBe(0)
  })

  it('a stored key is only reused while the base URL is unchanged', async () => {
    const u = await byokUser()
    const client = await loggedInClient(u.id)
    expect((await saveProvider(client, 'chat', { baseUrl: FAKE, model: 'fake-chat' })).status).toBe(400)
    expect((await saveProvider(client, 'chat', { baseUrl: FAKE, model: 'fake-chat', apiKey: uniqueKey('keep') })).status).toBe(200)
    // Same URL, no key → keeps the stored one (model change only).
    expect((await saveProvider(client, 'chat', { baseUrl: FAKE, model: 'no-tools-model' })).status).toBe(200)
    // New URL without a key → refused: a stored key never follows a URL change.
    const moved = await saveProvider(client, 'chat', { baseUrl: `${FAKE}/other`, model: 'fake-chat' })
    expect(moved.status).toBe(400)
  })

  it('verify + delete', async () => {
    const u = await byokUser()
    const client = await loggedInClient(u.id)
    await saveProvider(client, 'chat', { baseUrl: FAKE, model: 'fake-chat', apiKey: uniqueKey('verify') })
    const v = await client.post('/api/user/ai-providers/chat/verify', {})
    expect(v.status).toBe(200)
    expect(await v.json()).toMatchObject({ ok: true, code: 'ok' })
    expect((await client.delete('/api/user/ai-providers/chat')).status).toBe(200)
    expect((await client.delete('/api/user/ai-providers/chat')).status).toBe(404)
    expect((await client.post('/api/user/ai-providers/chat/verify', {})).status).toBe(404)
  })
})

describe('BYOK SSRF policy', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it.each([
    ['loopback IP literal', 'http://127.0.0.1:4120/v1', 'private-address'],
    ['cloud metadata address', 'http://169.254.169.254/latest', 'private-address'],
    ['IPv6 loopback', 'http://[::1]:4120/v1', 'private-address'],
    ['internal service hostname (litellm)', 'http://litellm:4000/v1', 'internal-host'],
    ['internal service hostname (postgres)', 'http://postgres:5432', 'internal-host'],
    ['localhost', 'http://localhost:4120/v1', 'internal-host'],
    // A public DNS name that resolves to 127.0.0.1 (nip.io wildcard DNS),
    // the DNS-rebinding shape: only the resolved address gives it away.
    ['hostname resolving to 127.0.0.1', 'http://127.0.0.1.nip.io:4120/v1', 'private-address'],
    ['credentials in URL', `https://user:pw@api.mistral.ai/v1`, 'credentials-in-url'],
    ['non-http scheme', 'file:///etc/passwd', 'scheme']
  ])('self-hosted (private opt-in ON) still refuses %s', async (_label, url, reason) => {
    const u = await byokUser()
    const client = await loggedInClient(u.id)
    const res = await saveProvider(client, 'chat', { baseUrl: url, model: 'fake-chat', apiKey: uniqueKey('ssrf') })
    expect(res.status).toBe(422)
    expect(await refusalReason(res)).toBe(reason)
  })

  it('self-hosted allows a private-network endpoint (the fake provider on the docker bridge)', async () => {
    const u = await byokUser()
    const client = await loggedInClient(u.id)
    expect((await saveProvider(client, 'chat', { baseUrl: FAKE, model: 'fake-chat', apiKey: uniqueKey('priv') })).status).toBe(200)
  })

  it('SaaS shape refuses a URL that is not on the provider allowlist (the same fake provider)', async () => {
    const u = await byokUser()
    const client = await loggedInClient(u.id, undefined, TEST_BILLING_OFF_BASE_URL)
    const res = await saveProvider(client, 'chat', { baseUrl: FAKE, model: 'fake-chat', apiKey: uniqueKey('saas') })
    expect(res.status).toBe(422)
    expect(await refusalReason(res)).toBe('not-allowlisted')
    const lookalike = await saveProvider(client, 'chat', { baseUrl: 'https://api.openai.com.evil.example/v1', model: 'm', apiKey: uniqueKey('saas2') })
    expect(await refusalReason(lookalike)).toBe('not-allowlisted')
  })

  it('SaaS shape lists the allowlisted presets only', async () => {
    const u = await byokUser()
    const client = await loggedInClient(u.id, undefined, TEST_BILLING_OFF_BASE_URL)
    const body: {
      policy: { allowedBaseUrls: string[], allowPrivate: boolean }
      presets: Array<{ id: string }>
    } = await (await client.get('/api/user/ai-providers')).json()
    expect(body.policy.allowPrivate).toBe(false)
    expect(body.policy.allowedBaseUrls).toContain('https://api.mistral.ai/v1')
    expect(body.presets.map(p => p.id)).not.toContain('ollama')
  })

  it('re-checks the stored URL at REQUEST time (DNS / policy can change after saving)', async () => {
    const u = await byokUser()
    const client = await loggedInClient(u.id)
    const key = uniqueKey('reqtime')
    await saveProvider(client, 'transcription', { baseUrl: FAKE, model: 'fake-whisper', apiKey: key })
    // Simulate "the host now resolves somewhere forbidden": point the
    // stored row at loopback behind the API's back.
    await testDb().query(`UPDATE user_ai_providers SET base_url = 'http://127.0.0.1:4120/v1' WHERE user_id = $1`, [u.id])
    await resetFake()
    const res = await client.post('/api/ai/transcribe', { audio: Buffer.alloc(400, 1).toString('base64'), mimeType: 'audio/webm' })
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain(key)
    expect((await fakeRequests()).filter(r => r.keySuffix === key.slice(-6))).toHaveLength(0)
  })
})

describe('resolution order: own key → instance default → unavailable', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('self-hosted: instance alias default is platform-billed; own key takes over', async () => {
    const u = await byokUser()
    const client = await loggedInClient(u.id)
    const before: { chat: { source: string, platformBilled: boolean }, transcription: { liveDictation: boolean } } = await (await client.get('/api/ai/availability')).json()
    expect(before.chat).toMatchObject({ source: 'instance', platformBilled: true })
    expect(before.transcription.liveDictation).toBe(true)
    await saveProvider(client, 'chat', { baseUrl: FAKE, model: 'fake-chat', apiKey: uniqueKey('order') })
    const after: { chat: { source: string, platformBilled: boolean } } = await (await client.get('/api/ai/availability')).json()
    expect(after.chat).toMatchObject({ source: 'user', platformBilled: false })
  })

  it('availability reports which platform web tools the operator configured', async () => {
    const u = await byokUser()
    const full: { webTools: { search: boolean, fetch: boolean } } = await (await (await loggedInClient(u.id)).get('/api/ai/availability')).json()
    expect(full.webTools).toEqual({ search: true, fetch: true })
    // Twin boots without STAAN_API_KEY: search is unavailable, fetch is not.
    const partial: { webTools: { search: boolean, fetch: boolean } } = await (await (await loggedInClient(u.id, undefined, TEST_BILLING_OFF_BASE_URL)).get('/api/ai/availability')).json()
    expect(partial.webTools).toEqual({ search: false, fetch: true })
  })

  it('SaaS: no instance defaults → AI entry points answer 409 ai/provider-missing', async () => {
    const u = await byokUser()
    const doc = await createDoc({ ownerId: u.id })
    const client = await loggedInClient(u.id, undefined, TEST_BILLING_OFF_BASE_URL)
    const avail: Record<string, { available: boolean, source: string }> = await (await client.get('/api/ai/availability')).json()
    expect(avail.chat).toMatchObject({ available: false, source: 'none' })
    expect(avail.image).toMatchObject({ available: false })
    expect(avail.transcription).toMatchObject({ available: false })

    const prompt = await client.post('/api/ai/prompt', { docId: doc.docId, prompt: 'hello' })
    expect(prompt.status).toBe(409)
    const promptBody: { data?: { code?: string, recovery?: { href?: string } } } = await prompt.json()
    expect(promptBody.data?.code).toBe('ai/provider-missing')
    expect(promptBody.data?.recovery?.href).toBe('/settings/ai')

    const transcribe = await client.post('/api/ai/transcribe', { audio: Buffer.alloc(400, 1).toString('base64'), mimeType: 'audio/webm' })
    expect(transcribe.status).toBe(409)
  })
})

describe('BYOK round trips through LiteLLM', () => {
  beforeEach(async () => {
    await resetDb()
    await resetFake()
  })

  it('chat: the agent loop runs on the user\'s provider, edits the doc, and costs the platform budget nothing', async () => {
    const u = await byokUser()
    const doc = await createDoc({ ownerId: u.id })
    const client = await loggedInClient(u.id)
    const key = uniqueKey('loop')
    expect((await saveProvider(client, 'chat', { baseUrl: FAKE, model: 'fake-chat', apiKey: key, supportsVision: false })).status).toBe(200)
    await resetFake()

    const res = await client.post('/api/ai/prompt', { docId: doc.docId, prompt: 'Say hello.' })
    expect(res.status).toBe(200)

    // Turn 1: tool call (insert_text). Turn 2: after the tool result → text, loop ends.
    const loopCalls = await waitFor(async () => {
      const calls = (await fakeRequests()).filter(r => r.keySuffix === key.slice(-6) && r.path.startsWith('/v1/chat/completions'))
      return calls.length >= 2 ? calls : null
    }, 30_000, 'two agent-loop turns at the fake provider')
    const firstTools = loopCalls[0]?.tools ?? []
    expect(firstTools).toContain('insert_text')
    // Text-only model: the image-input tools are not offered.
    expect(firstTools).not.toContain('view_image')
    expect(firstTools).not.toContain('view_pages')
    expect(loopCalls[0]?.model).toBe('fake-chat')

    // The tool call landed in the document (sync-test persists to yjs_updates).
    await waitFor(async () => ((await readYtext(doc.docId)).includes(DOC_MARKER) ? true : null), 20_000, 'the AI edit in yjs_updates')

    // Spend: LiteLLM logged the BYOK calls against the user's virtual key
    // with zero cost, so AI Points are untouched.
    const keyRow = await testDb().query<{ litellm_key_id: string }>('SELECT litellm_key_id FROM users WHERE id = $1', [u.id])
    const hashedKey = keyRow.rows[0]?.litellm_key_id
    expect(hashedKey).toBeTruthy()
    const pool = new Pool({ connectionString: LITELLM_DB_URL, max: 1 })
    try {
      const logs = await waitFor(async () => {
        const r = await pool.query<{ spend: number, model: string }>(
          `SELECT spend, model FROM "LiteLLM_SpendLogs" WHERE api_key = $1 AND model LIKE '%fake-chat%'`,
          [hashedKey]
        )
        return r.rows.length >= 2 ? r.rows : null
      }, 35_000, 'LiteLLM spend-log rows for the BYOK calls')
      for (const row of logs) expect(Number(row.spend)).toBe(0)
    } finally {
      await pool.end()
    }
    // And the key's budget counter itself is still at zero.
    const tokenRow = await testDb().query<{ litellm_key_token: string }>('SELECT litellm_key_token FROM users WHERE id = $1', [u.id])
    const plainKey = openSecret('litellm-user-key', secretContext.litellmUserKey(u.id), tokenRow.rows[0]?.litellm_key_token ?? '')
    const info = await fetch(`${LITELLM_URL}/key/info?key=${encodeURIComponent(plainKey)}`, {
      headers: { Authorization: `Bearer ${LITELLM_MASTER_KEY}` }
    })
    const infoBody: { info: { spend: number } } = await info.json()
    expect(infoBody.info.spend).toBe(0)
  // Three sequential async stages: the agent loop (two LLM turns), the
  // Hocuspocus 2 s debounce before yjs_updates is written, and
  // LiteLLM's batched spend-log writer (~10 s interval). Each wait above
  // is bounded on its own; the default 30 s project timeout is shorter
  // than their worst-case sum.
  }, 90_000)

  it('image: generate_image uses the user\'s OpenAI-compatible images API (no paid generation on save)', async () => {
    const u = await byokUser()
    const doc = await createDoc({ ownerId: u.id })
    const client = await loggedInClient(u.id)
    const key = uniqueKey('image')
    const saved = await saveProvider(client, 'image', { baseUrl: FAKE, model: 'fake-image', apiKey: key })
    expect(saved.status).toBe(200)
    // Verification listed models: it did NOT generate an image.
    const verifyCalls = (await fakeRequests()).filter(r => r.keySuffix === key.slice(-6))
    expect(verifyCalls.map(c => c.path)).toEqual(['/v1/models'])

    await resetFake()
    const res = await client.post('/api/_test/exec-ai-tool', {
      docId: doc.docId,
      name: 'generate_image',
      args: { prompt: 'a lighthouse at dusk', alt: 'Lighthouse' }
    })
    expect(res.status).toBe(200)
    const out: { isError: boolean, content: string } = await res.json()
    expect(out.isError, out.content).toBe(false)
    expect(out.content).toContain(`/api/files/${doc.docId}/`)
    const imageCalls = (await fakeRequests()).filter(r => r.keySuffix === key.slice(-6) && r.path.startsWith('/v1/images/generations'))
    expect(imageCalls).toHaveLength(1)
    expect(imageCalls[0]?.model).toBe('fake-image')
  })

  it('transcription: the voice prompt uses the user\'s /audio/transcriptions', async () => {
    const u = await byokUser()
    const client = await loggedInClient(u.id)
    const key = uniqueKey('stt')
    const saved = await saveProvider(client, 'transcription', { baseUrl: FAKE, model: 'fake-whisper', apiKey: key })
    expect(saved.status).toBe(200)
    const res = await client.post('/api/ai/transcribe', { audio: Buffer.alloc(400, 1).toString('base64'), mimeType: 'audio/webm' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: TRANSCRIPT, inaudible: false })
    const calls = (await fakeRequests()).filter(r => r.keySuffix === key.slice(-6) && r.path.startsWith('/v1/audio/transcriptions'))
    // One from verification (silent clip) + one real call.
    expect(calls.length).toBe(2)
    expect(calls.every(c => c.model === 'fake-whisper')).toBe(true)
    // A non-Mistral transcription key does not unlock live dictation.
    const avail: { transcription: { liveDictation: boolean, source: string } } = await (await client.get('/api/ai/availability')).json()
    expect(avail.transcription).toMatchObject({ source: 'user', liveDictation: false })
  })
})
