import { describe, it, expect, beforeEach, vi } from 'vitest'

// Pins the cost fix: the web_search / fetch_url Mistral synthesis
// sub-calls must authenticate with the CALLER'S LiteLLM virtual key
// (so token spend lands on their max_budget), NOT the master key.
// Before the fix both synthesis calls ran on `useLitellmAdmin()` and
// the spend was invisible to the per-user budget gate.

const mockClients = vi.hoisted(() => ({
  admin: { __kind: 'admin' },
  user: { __kind: 'user' }
}))

const useLitellmAdmin = vi.hoisted(() => vi.fn(() => mockClients.admin))
const useLitellmForUser = vi.hoisted(() => vi.fn((_key: string) => mockClients.user))
const litellmCompletion = vi.hoisted(() =>
  vi.fn(async () => ({ choices: [{ message: { content: 'Synthesised answer.' } }] }))
)

vi.mock('../../server/utils/litellmClient', () => ({ useLitellmAdmin, useLitellmForUser }))
vi.mock('../../server/utils/litellm/createCompletion', () => ({ litellmCompletion }))
// fetch_url routes through the SSRF guard before hitting the network —
// stub it so the test doesn't do DNS resolution.
vi.mock('../../server/utils/agentic/urlGuard', () => ({ assertSafeUrl: vi.fn(async () => {}) }))

const runtimeConfig = { litellm: { textModel: 'mistral-small-2603' } }
;(globalThis as unknown as { useRuntimeConfig: () => typeof runtimeConfig }).useRuntimeConfig = () => runtimeConfig

const { webSearch, fetchUrl } = await import('../../server/utils/agentic/functionTools')

const neverAbort = new AbortController().signal

beforeEach(() => {
  useLitellmAdmin.mockClear()
  useLitellmForUser.mockClear()
  litellmCompletion.mockClear()
  process.env.STAAN_API_KEY = 'staan-test-key'
  process.env.JINA_AI_API_KEY = 'jina-test-key'
})

/** Staan returns a search envelope; Jina Reader returns page markdown. */
function stubFetch(kind: 'staan' | 'jina') {
  const body = kind === 'staan'
    ? { web: { results: [{ title: 'T', url: 'https://example.com', snippet: 'S' }] } }
    : { data: { content: '# Page\n\nBody text.', title: 'Page' } }
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body })))
}

describe('web_search synthesis billing key', () => {
  it('uses the caller virtual key when provided', async () => {
    stubFetch('staan')
    await webSearch(undefined, '', 'query', neverAbort, { virtualKey: 'sk-user-123' })
    expect(useLitellmForUser).toHaveBeenCalledWith('sk-user-123')
    expect(useLitellmAdmin).not.toHaveBeenCalled()
    expect(litellmCompletion).toHaveBeenCalledWith(mockClients.user, expect.anything(), expect.anything())
  })

  it('falls back to the master key when no virtual key is passed', async () => {
    stubFetch('staan')
    await webSearch(undefined, '', 'query', neverAbort, {})
    expect(useLitellmAdmin).toHaveBeenCalled()
    expect(useLitellmForUser).not.toHaveBeenCalled()
    expect(litellmCompletion).toHaveBeenCalledWith(mockClients.admin, expect.anything(), expect.anything())
  })
})

describe('fetch_url synthesis billing key', () => {
  it('uses the caller virtual key when provided', async () => {
    stubFetch('jina')
    await fetchUrl(undefined, '', 'https://example.com', neverAbort, { virtualKey: 'sk-user-456' })
    expect(useLitellmForUser).toHaveBeenCalledWith('sk-user-456')
    expect(useLitellmAdmin).not.toHaveBeenCalled()
    expect(litellmCompletion).toHaveBeenCalledWith(mockClients.user, expect.anything(), expect.anything())
  })

  it('falls back to the master key when no virtual key is passed', async () => {
    stubFetch('jina')
    await fetchUrl(undefined, '', 'https://example.com', neverAbort, {})
    expect(useLitellmAdmin).toHaveBeenCalled()
    expect(useLitellmForUser).not.toHaveBeenCalled()
  })
})
