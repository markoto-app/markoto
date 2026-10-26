import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ResolvedAiProvider } from '../../server/utils/aiProviders/resolve'

// Pins two things about the web_search / fetch_url synthesis sub-calls:
//
//  1. Cost attribution: they authenticate with the CALLER'S LiteLLM
//     virtual key (rpm limits + spend tags), never the master key —
//     before that fix both synthesis calls ran on `useLitellmAdmin()`.
//  2. BYOK (WP4): they run on the session's chat provider — a platform
//     alias is sent as-is, a user key goes out as `byok/<model>` with
//     clientside credentials — and with no chat provider at all the
//     tools return the raw search results / page text unsynthesised.

const mockClients = vi.hoisted(() => ({
  admin: { __kind: 'admin' },
  user: { __kind: 'user' }
}))

const useLitellmAdmin = vi.hoisted(() => vi.fn(() => mockClients.admin))
const useLitellmForUser = vi.hoisted(() => vi.fn((_key: string) => mockClients.user))
const litellmCompletion = vi.hoisted(() =>
  vi.fn(async (_client: unknown, _body: Record<string, unknown>, _opts?: unknown) => ({ choices: [{ message: { content: 'Synthesised answer.' } }] }))
)

vi.mock('../../server/utils/litellmClient', () => ({ useLitellmAdmin, useLitellmForUser }))
vi.mock('../../server/utils/litellm/createCompletion', () => ({ litellmCompletion }))
// fetch_url routes through the SSRF guard before hitting the network —
// stub only `assertSafeUrl` so the test doesn't do DNS resolution; the
// IP classifiers stay real (the BYOK URL policy uses them).
vi.mock('../../server/utils/agentic/urlGuard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/utils/agentic/urlGuard')>()
  return { ...actual, assertSafeUrl: vi.fn(async () => {}) }
})

const { webSearch, fetchUrl } = await import('../../server/utils/agentic/functionTools')

const neverAbort = new AbortController().signal

const aliasProvider: ResolvedAiProvider = {
  capability: 'chat',
  source: 'instance',
  model: 'mistral-small-2603',
  credentials: null,
  supportsVision: true
}

// IP-literal base URL in TEST-NET-3 (public, never routed) so the
// request-time SSRF check needs no DNS.
const byokProvider: ResolvedAiProvider = {
  capability: 'chat',
  source: 'user',
  model: 'gpt-5.4-mini',
  credentials: { baseUrl: 'https://203.0.113.10/v1', apiKey: 'sk-user-own-provider-key' },
  supportsVision: false
}

beforeEach(() => {
  useLitellmAdmin.mockClear()
  useLitellmForUser.mockClear()
  litellmCompletion.mockClear()
  process.env.STAAN_API_KEY = 'staan-test-key'
  process.env.JINA_AI_API_KEY = 'jina-test-key'
  delete process.env.NUXT_AI_BYOK_ALLOWED_BASE_URLS
  delete process.env.NUXT_AI_BYOK_ALLOW_PRIVATE_URLS
})

/** Staan returns a search envelope; Jina Reader returns page markdown. */
function stubFetch(kind: 'staan' | 'jina') {
  const body = kind === 'staan'
    ? { web: { results: [{ title: 'T', url: 'https://example.com', snippet: 'S' }] } }
    : { data: { content: '# Page\n\nBody text.', title: 'Page' } }
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body })))
}

function lastBody(): Record<string, unknown> {
  const call = litellmCompletion.mock.calls.at(-1)
  if (!call) throw new Error('litellmCompletion was not called')
  return call[1]
}

describe('web_search synthesis billing key', () => {
  it('uses the caller virtual key when provided', async () => {
    stubFetch('staan')
    await webSearch(undefined, '', 'query', neverAbort, { virtualKey: 'sk-user-123', chatProvider: aliasProvider })
    expect(useLitellmForUser).toHaveBeenCalledWith('sk-user-123')
    expect(useLitellmAdmin).not.toHaveBeenCalled()
    expect(litellmCompletion).toHaveBeenCalledWith(mockClients.user, expect.anything(), expect.anything())
    expect(lastBody().model).toBe('mistral-small-2603')
    expect(lastBody().api_key).toBeUndefined()
  })

  it('falls back to the master key when no virtual key is passed', async () => {
    stubFetch('staan')
    await webSearch(undefined, '', 'query', neverAbort, { chatProvider: aliasProvider })
    expect(useLitellmAdmin).toHaveBeenCalled()
    expect(useLitellmForUser).not.toHaveBeenCalled()
    expect(litellmCompletion).toHaveBeenCalledWith(mockClients.admin, expect.anything(), expect.anything())
  })

  it('runs the synthesis on the BYOK provider with clientside credentials', async () => {
    stubFetch('staan')
    await webSearch(undefined, '', 'query', neverAbort, { virtualKey: 'sk-user-123', chatProvider: byokProvider })
    const body = lastBody()
    expect(body.model).toBe('byok/gpt-5.4-mini')
    expect(body.api_key).toBe('sk-user-own-provider-key')
    expect(body.api_base).toBe('https://203.0.113.10/v1')
  })

  it('returns the raw results without an LLM call when no chat provider is configured', async () => {
    stubFetch('staan')
    const out = await webSearch(undefined, '', 'query', neverAbort, { virtualKey: 'sk-user-123', chatProvider: null })
    expect(litellmCompletion).not.toHaveBeenCalled()
    expect(out.text).toContain('https://example.com')
    expect(out.sources).toEqual([{ title: 'T', uri: 'https://example.com' }])
  })
})

describe('fetch_url synthesis billing key', () => {
  it('uses the caller virtual key when provided', async () => {
    stubFetch('jina')
    await fetchUrl(undefined, '', 'https://example.com', neverAbort, { virtualKey: 'sk-user-456', chatProvider: aliasProvider })
    expect(useLitellmForUser).toHaveBeenCalledWith('sk-user-456')
    expect(useLitellmAdmin).not.toHaveBeenCalled()
    expect(litellmCompletion).toHaveBeenCalledWith(mockClients.user, expect.anything(), expect.anything())
  })

  it('falls back to the master key when no virtual key is passed', async () => {
    stubFetch('jina')
    await fetchUrl(undefined, '', 'https://example.com', neverAbort, { chatProvider: aliasProvider })
    expect(useLitellmAdmin).toHaveBeenCalled()
    expect(useLitellmForUser).not.toHaveBeenCalled()
  })

  it('returns the page text without an LLM call when no chat provider is configured', async () => {
    stubFetch('jina')
    const out = await fetchUrl(undefined, '', 'https://example.com', neverAbort, { chatProvider: null })
    expect(litellmCompletion).not.toHaveBeenCalled()
    expect(out.text).toContain('Body text.')
  })
})
