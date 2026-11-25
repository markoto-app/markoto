import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// `fetch_url` reads pages with Staan Fetch (POST https://api.staan.ai/v1/fetch,
// same key as web_search). Pins the request (one parsed URL, Markdown with
// images, bearer key, a timeout) and how every Staan answer reaches the
// model: page content, per-URL errors, `content: null` with a content_error,
// HTTP errors, our own timeout, oversized and malformed bodies.

const litellmCompletion = vi.hoisted(() =>
  vi.fn(async (_client: unknown, _body: Record<string, unknown>, _opts?: unknown) => ({ choices: [{ message: { content: 'ok' } }] }))
)
vi.mock('../../../server/utils/ai/litellmClient', () => ({ useLitellmAdmin: () => ({}), useLitellmForUser: () => ({}) }))
vi.mock('../../../server/utils/litellm/createCompletion', () => ({ litellmCompletion }))
vi.mock('../../../server/utils/agentic/urlGuard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/utils/agentic/urlGuard')>()
  return { ...actual, assertSafeUrl: vi.fn(async () => {}) }
})

const { fetchUrl, STAAN_FETCH_URL, STAAN_FETCH_TIMEOUT_MS } = await import('../../../server/utils/ai/tools/fetchUrl')

const neverAbort = new AbortController().signal

function stubStaan(body: unknown, status = 200) {
  const mock = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', mock)
  return mock
}

async function read(url = 'https://example.com/a') {
  return await fetchUrl(undefined, '', url, neverAbort, { chatProvider: null })
}

beforeEach(() => {
  litellmCompletion.mockClear()
  vi.stubEnv('STAAN_API_KEY', 'staan-test-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('fetch_url via Staan Fetch: request', () => {
  it('posts one parsed URL as Markdown with images, with the bearer key and a timeout signal', async () => {
    const mock = stubStaan({ results: [{ url: 'https://example.com/a', title: 'A', content: 'Hello' }], errors: [] })
    await read('example.com/a')
    expect(mock).toHaveBeenCalledTimes(1)
    const [url, init] = mock.mock.calls[0]!
    expect(url).toBe(STAAN_FETCH_URL)
    expect(STAAN_FETCH_URL).toBe('https://api.staan.ai/v1/fetch')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer staan-test-key')
    expect(JSON.parse(String(init?.body))).toEqual({ urls: ['https://example.com/a'], format: 'markdown', include_images: true })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    // Staan allows 20 s per page; we wait a little longer, never forever.
    expect(STAAN_FETCH_TIMEOUT_MS).toBeGreaterThan(20_000)
    expect(STAAN_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })

  it('is not offered without the Staan key', async () => {
    vi.stubEnv('STAAN_API_KEY', '')
    const mock = stubStaan({})
    await expect(read()).rejects.toThrow(/not configured/)
    expect(mock).not.toHaveBeenCalled()
  })
})

describe('fetch_url via Staan Fetch: answers', () => {
  it('success: the page Markdown and title reach the caller', async () => {
    stubStaan({ request_id: 'r', results: [{ url: 'https://example.com/a', final_url: 'https://example.com/a', title: 'Title A', content: '# A\n\nBody.', content_error: null, content_format: 'markdown' }], errors: [], usage: { urls_billed: 1 } })
    const out = await read()
    expect(out.text).toBe('Page: Title A\n\n# A\n\nBody.')
    expect(out.url).toBe('https://example.com/a')
  })

  it.each([
    ['timeout', null, /longer than 20 seconds/],
    ['blocked', 403, /refuses automated access/],
    ['not_found', 404, /does not exist \(HTTP 404\)/],
    ['unsupported', null, /cannot be read as text/],
    ['error', 500, /could not be fetched \(HTTP 500\)/],
    ['something_new', null, /could not be fetched\./]
  ])('an error entry (%s) becomes a fixed sentence for the model', async (status, httpStatus, expected) => {
    stubStaan({ results: [], errors: [{ url: 'https://example.com/a', status, message: 'upstream says <script>', http_status: httpStatus }] })
    const out = await read()
    expect(out.text).toMatch(/^Unable to extract content from https:\/\/example\.com\/a\. /)
    expect(out.text).toMatch(expected)
    // Never Staan's own wording.
    expect(out.text).not.toContain('upstream says')
    expect(out.summary).toBe('')
  })

  it('content null with too_short: the page probably needs JavaScript', async () => {
    stubStaan({ results: [{ url: 'https://example.com/a', title: 'App', content: null, content_error: 'too_short' }], errors: [] })
    const out = await read()
    expect(out.text).toMatch(/JavaScript/)
    expect(out.text).toMatch(/web_search/)
  })

  it('content null with extraction_failed: no main content', async () => {
    stubStaan({ results: [{ url: 'https://example.com/a', content: null, content_error: 'extraction_failed' }], errors: [] })
    const out = await read()
    expect(out.text).toMatch(/main content of the page could not be extracted/)
  })

  it('no result and no error entry: a generic failure', async () => {
    stubStaan({ results: [], errors: [] })
    expect((await read()).text).toMatch(/could not be fetched/)
  })

  it.each([
    [429, /busy \(rate limited\)/],
    [401, /temporarily unavailable/],
    [403, /temporarily unavailable/],
    [502, /returned an error \(502\)/]
  ])('HTTP %i from Staan becomes a tool result, not a crash', async (status, expected) => {
    stubStaan({ message: 'nope' }, status)
    const out = await read()
    expect(out.text).toMatch(expected)
  })

  it('a malformed body is a tool result', async () => {
    stubStaan('<html>gateway</html>')
    expect((await read()).text).toMatch(/returned an error/)
  })

  it('mistyped fields read as absent', async () => {
    stubStaan({ results: [{ title: 42, content: 'Text body' }, 'junk'], errors: 'x' })
    const out = await read()
    expect(out.text).toBe('Page: https://example.com/a\n\nText body')
  })

  it('an oversized response body is refused without buffering it all', async () => {
    const big = 'x'.repeat(5 * 1024 * 1024)
    stubStaan({ results: [{ content: big }], errors: [] })
    expect((await read()).text).toMatch(/too large/)
  })

  it('a long page is cut at 50 extract pages worth of Markdown (400,000 characters)', async () => {
    const para = `${'word '.repeat(150).trim()}\n\n`
    const content = `${para.repeat(800)}TAIL-MARKER`
    expect(content.length).toBeGreaterThan(400_000)
    const extract = async (page: number) => {
      stubStaan({ results: [{ title: 'Long', content }], errors: [] })
      return (await fetchUrl(undefined, '', 'https://example.com/a', neverAbort, {}, { mode: 'extract', page })).text
    }
    const first = await extract(1)
    const total = Number(/Part 1 of (\d+)\./.exec(first)?.[1])
    expect(total).toBeGreaterThan(40)
    expect(await extract(total)).not.toContain('TAIL-MARKER')
  })
})

describe('fetch_url via Staan Fetch: timeouts and aborts', () => {
  it('our own timeout becomes a tool result', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort(new DOMException('timed out', 'TimeoutError')))
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      init?.signal?.throwIfAborted()
      return new Response('{}')
    }))
    const out = await read()
    expect(out.text).toMatch(/longer than 20 seconds/)
    vi.mocked(AbortSignal.timeout).mockRestore()
  })

  it('the caller\'s abort propagates', async () => {
    const ctrl = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => {
      ctrl.abort()
      throw new DOMException('aborted', 'AbortError')
    }))
    await expect(fetchUrl(undefined, '', 'https://example.com/a', ctrl.signal, {})).rejects.toThrow(/abort/i)
  })

  it('a network error propagates', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed')
    }))
    await expect(read()).rejects.toThrow('fetch failed')
  })
})
