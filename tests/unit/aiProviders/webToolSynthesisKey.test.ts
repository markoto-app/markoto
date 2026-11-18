import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ResolvedAiProvider } from '../../../server/utils/aiProviders/resolve'

// Pins two things about the web_search / fetch_url synthesis sub-calls:
//
//  1. Cost attribution: they authenticate with the CALLER'S LiteLLM
//     virtual key (rpm limits + spend tags), never the master key (`useLitellmAdmin()`).
//  2. BYOK: they run on the session's chat provider, a platform
//     alias is sent as-is, a user key goes out as `byok/<model>` with
//     clientside credentials: and with no chat provider at all the
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

vi.mock('../../../server/utils/ai/litellmClient', () => ({ useLitellmAdmin, useLitellmForUser }))
vi.mock('../../../server/utils/litellm/createCompletion', () => ({ litellmCompletion }))
// fetch_url routes through the SSRF guard before hitting the network,
// stub only `assertSafeUrl` so the test doesn't do DNS resolution; the
// IP classifiers stay real (the BYOK URL policy uses them).
vi.mock('../../../server/utils/agentic/urlGuard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/utils/agentic/urlGuard')>()
  return { ...actual, assertSafeUrl: vi.fn(async () => {}) }
})

const { webSearch } = await import('../../../server/utils/ai/tools/webSearch')
const { fetchUrl } = await import('../../../server/utils/ai/tools/fetchUrl')

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
  credentials: { baseUrl: 'https://93.184.215.14/v1', apiKey: 'sk-user-own-provider-key' },
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
    expect(body.api_base).toBe('https://93.184.215.14/v1')
  })

  it('returns the raw results without an LLM call when no chat provider is configured', async () => {
    stubFetch('staan')
    const out = await webSearch(undefined, '', 'query', neverAbort, { virtualKey: 'sk-user-123', chatProvider: null })
    // Only the per-call charge (webToolCharge.test.ts), no synthesis.
    expect(litellmCompletion.mock.calls.map(c => c[1].model)).toEqual(['web-search-tick'])
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

  // Regression (parser differential): the raw string was forwarded, so a
  // reader that parses "\" differently from WHATWG could fetch another host
  // than the one the guard checked.
  it('forwards the parsed URL the guard checked, not the raw input', async () => {
    stubFetch('jina')
    await fetchUrl(undefined, '', 'https://allowed.example\\@internal.example/', neverAbort, { chatProvider: null })
    const fetchMock = vi.mocked(fetch)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://r.jina.ai/https://allowed.example/@internal.example/')
  })

  it('returns the page text without an LLM call when no chat provider is configured', async () => {
    stubFetch('jina')
    const out = await fetchUrl(undefined, '', 'https://example.com', neverAbort, { chatProvider: null })
    expect(litellmCompletion).not.toHaveBeenCalled()
    expect(out.text).toContain('Body text.')
  })
})

describe('web-tool synthesis on the worker model', () => {
  const worker: ResolvedAiProvider = { capability: 'chat', source: 'instance', model: 'markoto-worker', credentials: null, supportsVision: false }

  function synthesisBodies(): Array<Record<string, unknown>> {
    return litellmCompletion.mock.calls.map(c => c[1]).filter(b => !String(b.model).endsWith('-tick'))
  }

  it('web_search synthesises on the worker, tagged feature:utility', async () => {
    stubFetch('staan')
    await webSearch(undefined, '', 'query', neverAbort, { virtualKey: 'sk-user-1', workspaceId: 'w1', docId: 'd1', chatProvider: aliasProvider, workerProvider: worker })
    const [body] = synthesisBodies()
    expect(body?.model).toBe('markoto-worker')
    expect(body?.metadata).toEqual({ tags: ['feature:utility', 'workspace:w1', 'doc:d1'] })
  })

  it('fetch_url extracts on the worker, tagged feature:utility', async () => {
    stubFetch('jina')
    await fetchUrl(undefined, '', 'https://example.com', neverAbort, { virtualKey: 'sk-user-1', chatProvider: aliasProvider, workerProvider: worker })
    const [body] = synthesisBodies()
    expect(body?.model).toBe('markoto-worker')
    expect(body?.metadata).toEqual({ tags: ['feature:utility'] })
  })

  it('a BYOK fast model runs with the chat provider\'s clientside credentials', async () => {
    stubFetch('jina')
    const fast = { ...byokProvider, model: 'gpt-5.4-nano' }
    await fetchUrl(undefined, '', 'https://example.com', neverAbort, { virtualKey: 'sk-user-1', chatProvider: byokProvider, workerProvider: fast })
    const [body] = synthesisBodies()
    expect(body).toMatchObject({ model: 'byok/gpt-5.4-nano', api_key: 'sk-user-own-provider-key', api_base: 'https://93.184.215.14/v1' })
  })

  it('an explicit null worker means no synthesis, even with a chat provider', async () => {
    stubFetch('jina')
    const out = await fetchUrl(undefined, '', 'https://example.com', neverAbort, { chatProvider: aliasProvider, workerProvider: null })
    expect(synthesisBodies()).toEqual([])
    expect(out.text).toContain('Body text.')
  })
})

describe('fetch_url question and extract modes', () => {
  function stubPage(content: string) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { content, title: 'Long page' } }) })))
  }

  it('question: the extractor is asked the question and the answer is labelled', async () => {
    stubFetch('jina')
    litellmCompletion.mockImplementationOnce(async () => ({ choices: [{ message: { content: JSON.stringify({ summary: 'It opened in 1999.', images: [] }) } }] }))
    const out = await fetchUrl(undefined, '', 'https://example.com', neverAbort, { chatProvider: aliasProvider }, { question: 'When did it open?' })
    const messages = lastBody().messages as Array<{ role: string, content: string }>
    expect(messages[0]?.content).toContain('answers the question')
    expect(messages[1]?.content.startsWith('Question: When did it open?\n')).toBe(true)
    expect(out.text).toContain('Answer from the page:\nIt opened in 1999.')
    expect(out.summary).toBe('It opened in 1999.')
  })

  it('extract: returns the Markdown in ~8k-character pages without a model call', async () => {
    const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}. ${'word '.repeat(100)}`.trim())
    const markdown = paragraphs.join('\n\n')
    stubPage(markdown)
    const first = await fetchUrl(undefined, '', 'https://example.com', neverAbort, { chatProvider: aliasProvider }, { mode: 'extract' })
    expect(litellmCompletion.mock.calls.filter(c => !String(c[1].model).endsWith('-tick'))).toEqual([])
    const total = Number(/Part 1 of (\d+)\./.exec(first.text)?.[1])
    expect(total).toBeGreaterThan(1)
    expect(first.text).toContain('Call fetch_url with mode "extract" and page 2 for the next page.')
    expect(first.text).toContain('Paragraph 1.')

    // Pages break between paragraphs and together hold the whole page.
    const bodies: string[] = []
    for (let page = 1; page <= total; page++) {
      stubPage(markdown)
      const out = await fetchUrl(undefined, '', 'https://example.com', neverAbort, {}, { mode: 'extract', page })
      const body = out.text.split('\n\n').slice(1).join('\n\n')
      expect(body.length).toBeLessThanOrEqual(8000)
      bodies.push(body)
    }
    expect(bodies.join('\n\n')).toBe(markdown)
    expect(bodies.at(-1)).toContain('Paragraph 30.')

    // Past the end: the last page, which says so.
    stubPage(markdown)
    const past = await fetchUrl(undefined, '', 'https://example.com', neverAbort, {}, { mode: 'extract', page: total + 5 })
    expect(past.text).toContain(`Part ${total} of ${total}. This is the last page.`)
  })

  it('extract: a short page is one page', async () => {
    stubFetch('jina')
    const out = await fetchUrl(undefined, '', 'https://example.com', neverAbort, {}, { mode: 'extract' })
    expect(out.text).toContain('Part 1 of 1. This is the last page.')
    expect(out.text).toContain('# Page\n\nBody text.')
  })
})
