import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createError } from 'h3'
import type { ResolvedAiProvider } from '../../../server/utils/aiProviders/resolve'

// Web search and page fetch (both Staan) are charged to the
// caller's AI budget through a billing-only LiteLLM tick model before the
// upstream call (`server/utils/ai/webToolCharge.ts`). Pins: which model /
// key / tags the tick uses, when it is skipped, how a budget refusal maps
// to the user-facing errors, and that a refusal stops the upstream call.

// `freeAllowanceExhaustedHttpError` uses Nitro's auto-imported createError.
Object.assign(globalThis, { createError })

const mockClient = vi.hoisted(() => ({ __kind: 'user' }))
const useLitellmForUser = vi.hoisted(() => vi.fn((_key: string) => mockClient))
const useLitellmAdmin = vi.hoisted(() => vi.fn(() => ({ __kind: 'admin' })))
const litellmCompletion = vi.hoisted(() =>
  vi.fn(async (_client: unknown, _body: Record<string, unknown>, _opts?: unknown) => ({ choices: [{ message: { content: 'ok' } }] }))
)
const consumeWebToolQuota = vi.hoisted(() => vi.fn(async (_userId: number | null | undefined) => {}))

vi.mock('../../../server/utils/ai/litellmClient', () => ({ useLitellmAdmin, useLitellmForUser }))
vi.mock('../../../server/utils/litellm/createCompletion', () => ({ litellmCompletion }))
vi.mock('../../../server/utils/ai/webTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/utils/ai/webTools')>()
  return { ...actual, consumeWebToolQuota }
})
vi.mock('../../../server/utils/agentic/urlGuard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/utils/agentic/urlGuard')>()
  return { ...actual, assertSafeUrl: vi.fn(async () => {}) }
})

const { chargeWebToolCall, webToolBudgetRefusal, isWebToolBudgetRefusal, webToolTickModel } = await import('../../../server/utils/ai/webToolCharge')
const { webSearch } = await import('../../../server/utils/ai/tools/webSearch')
const { fetchUrl } = await import('../../../server/utils/ai/tools/fetchUrl')
const { TEAM_BUDGET_EXHAUSTED_MESSAGE, MEMBER_LIMIT_REACHED_MESSAGE } = await import('../../../server/utils/litellm/workspaceTeams')
const { FREE_ALLOWANCE_EXHAUSTED_MESSAGE } = await import('../../../server/utils/litellm/freeTierTeam')

// LiteLLM's refusal texts (v1.106.4).
const KEY_EXHAUSTED = new Error('Budget has been exceeded! Key=sk-...abcd Current cost: 0.51, Max budget: 0.5')
const FREE_POOL_EXHAUSTED = new Error('Budget has been exceeded! Team=markoto-free-tier Current cost: 501, Max budget: 500')
const WORKSPACE_TEAM_EXHAUSTED = new Error('Budget has been exceeded! Team=markoto-ws-abc Current cost: 31, Max budget: 30')

const aliasProvider: ResolvedAiProvider = { capability: 'chat', source: 'instance', model: 'zai-glm-5-3-flash', credentials: null, supportsVision: true }
const byokProvider: ResolvedAiProvider = {
  capability: 'chat',
  source: 'user',
  model: 'gpt-5.4-mini',
  credentials: { baseUrl: 'https://93.184.215.14/v1', apiKey: 'sk-own' },
  supportsVision: false
}

const neverAbort = new AbortController().signal

function tickCalls() {
  return litellmCompletion.mock.calls.filter(c => String(c[1].model).endsWith('-tick'))
}

beforeEach(() => {
  litellmCompletion.mockReset()
  litellmCompletion.mockImplementation(async () => ({ choices: [{ message: { content: 'ok' } }] }))
  useLitellmForUser.mockClear()
  consumeWebToolQuota.mockReset()
  consumeWebToolQuota.mockImplementation(async () => {})
  vi.stubEnv('STAAN_API_KEY', 'staan-test-key')
  vi.stubEnv('NUXT_BILLING_ENABLED', 'false')
  vi.stubEnv('NUXT_PLANS_COMING_SOON', 'false')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('webToolTickModel', () => {
  it('defaults to the bundled tick deployments', () => {
    expect(webToolTickModel('web_search')).toBe('web-search-tick')
    expect(webToolTickModel('fetch_url')).toBe('web-fetch-tick')
  })

  it('follows an override, and an empty value switches charging off', () => {
    vi.stubEnv('NUXT_LITELLM_WEB_SEARCH_TICK_MODEL', 'my-search-tick')
    vi.stubEnv('NUXT_LITELLM_WEB_FETCH_TICK_MODEL', '')
    expect(webToolTickModel('web_search')).toBe('my-search-tick')
    expect(webToolTickModel('fetch_url')).toBeNull()
  })
})

describe('chargeWebToolCall', () => {
  it('bills one tick on the caller key with the feature + context tags', async () => {
    await chargeWebToolCall('web_search', { virtualKey: 'sk-user-1', userId: 7, workspaceId: 'ws-1', docId: 'doc-1' }, neverAbort)
    expect(useLitellmForUser).toHaveBeenCalledWith('sk-user-1')
    expect(litellmCompletion).toHaveBeenCalledTimes(1)
    const [client, body] = litellmCompletion.mock.calls[0]!
    expect(client).toBe(mockClient)
    expect(body.model).toBe('web-search-tick')
    expect(body.max_tokens).toBe(1)
    expect(body.metadata).toEqual({ tags: ['feature:web-search', 'workspace:ws-1', 'user:7', 'doc:doc-1'] })
  })

  it('uses the fetch tick and tag for fetch_url', async () => {
    await chargeWebToolCall('fetch_url', { virtualKey: 'sk-user-1', userId: 7 })
    const body = litellmCompletion.mock.calls[0]![1]
    expect(body.model).toBe('web-fetch-tick')
    expect(body.metadata).toEqual({ tags: ['feature:web-fetch', 'user:7'] })
  })

  it('skips a key-less harness call and a switched-off tick', async () => {
    await chargeWebToolCall('web_search', { userId: 7 })
    vi.stubEnv('NUXT_LITELLM_WEB_SEARCH_TICK_MODEL', '')
    await chargeWebToolCall('web_search', { virtualKey: 'sk-user-1' })
    expect(litellmCompletion).not.toHaveBeenCalled()
  })

  it('lets the call go ahead when the tick fails for another reason (proxy down, model missing)', async () => {
    litellmCompletion.mockRejectedValueOnce(new Error('400 Invalid model name passed in model=web-search-tick'))
    await expect(chargeWebToolCall('web_search', { virtualKey: 'sk-user-1' })).resolves.toBeUndefined()
  })

  it('rethrows when the caller aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    litellmCompletion.mockRejectedValueOnce(new Error('aborted'))
    await expect(chargeWebToolCall('web_search', { virtualKey: 'sk-user-1' }, ac.signal)).rejects.toThrow('aborted')
  })

  it('refuses with 402 ai/budget-exhausted when the key budget is used up', async () => {
    litellmCompletion.mockRejectedValueOnce(KEY_EXHAUSTED)
    const err = await chargeWebToolCall('web_search', { virtualKey: 'sk-user-1', attributedTo: 'user:7' }).catch((e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 402, data: { code: 'ai/budget-exhausted', messageKey: 'ai.budgetExhaustedResetDescription' } })
    expect(isWebToolBudgetRefusal(err)).toBe(true)
  })
})

describe('webToolBudgetRefusal', () => {
  it('maps the shared free pool to ai/free-allowance-exhausted', () => {
    const err = webToolBudgetRefusal(FREE_POOL_EXHAUSTED, { attributedTo: 'user:7', chatProvider: aliasProvider })
    expect(err).toMatchObject({ statusCode: 402, message: FREE_ALLOWANCE_EXHAUSTED_MESSAGE, data: { code: 'ai/free-allowance-exhausted' } })
  })

  it('does not tell a user whose chat runs on their own key to add one', () => {
    const err = webToolBudgetRefusal(FREE_POOL_EXHAUSTED, { attributedTo: 'user:7', chatProvider: byokProvider })
    expect(err?.data).toEqual({ code: 'ai/free-allowance-exhausted' })
    expect(err?.message).not.toBe(FREE_ALLOWANCE_EXHAUSTED_MESSAGE)
    expect(err?.message).toMatch(/Web search and page fetch/)
  })

  it('maps a workspace team budget and a member limit to their own texts', () => {
    expect(webToolBudgetRefusal(WORKSPACE_TEAM_EXHAUSTED, { attributedTo: 'workspace:abc' }))
      .toMatchObject({ statusCode: 402, message: TEAM_BUDGET_EXHAUSTED_MESSAGE, data: { code: 'ai/budget-exhausted' } })
    expect(webToolBudgetRefusal(KEY_EXHAUSTED, { attributedTo: 'workspace:abc' }))
      .toMatchObject({ statusCode: 402, message: MEMBER_LIMIT_REACHED_MESSAGE, data: { code: 'ai/budget-exhausted' } })
  })

  it('returns null for anything that is not a budget refusal', () => {
    expect(webToolBudgetRefusal(new Error('500 upstream'))).toBeNull()
    expect(isWebToolBudgetRefusal(new Error('500 upstream'))).toBe(false)
  })
})

describe('web tools charge before the upstream call', () => {
  function stubFetch(body: unknown) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('web_search: counts the rate limit, then charges, then calls Staan', async () => {
    const order: string[] = []
    consumeWebToolQuota.mockImplementation(async () => {
      order.push('quota')
    })
    litellmCompletion.mockImplementation(async (_c, body) => {
      order.push(String(body.model))
      return { choices: [{ message: { content: 'answer' } }] }
    })
    const fetchMock = stubFetch({ web: { results: [{ title: 'T', url: 'https://example.com', snippet: 'S' }] } })
    fetchMock.mockImplementation(async () => {
      order.push('staan')
      return new Response(JSON.stringify({ web: { results: [{ title: 'T', url: 'https://example.com', snippet: 'S' }] } }), { status: 200 })
    })
    await webSearch(undefined, '', 'query', neverAbort, { virtualKey: 'sk-user-1', userId: 7, chatProvider: aliasProvider })
    expect(order).toEqual(['quota', 'web-search-tick', 'staan', 'zai-glm-5-3-flash'])
  })

  it('web_search: a refused charge never reaches Staan', async () => {
    litellmCompletion.mockRejectedValueOnce(KEY_EXHAUSTED)
    const fetchMock = stubFetch({})
    await expect(webSearch(undefined, '', 'query', neverAbort, { virtualKey: 'sk-user-1', userId: 7, chatProvider: aliasProvider }))
      .rejects.toMatchObject({ statusCode: 402 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('web_search: a refused rate limit is not charged', async () => {
    consumeWebToolQuota.mockRejectedValueOnce(Object.assign(new Error('limit'), { statusCode: 429 }))
    stubFetch({})
    await expect(webSearch(undefined, '', 'query', neverAbort, { virtualKey: 'sk-user-1', userId: 7 })).rejects.toThrow('limit')
    expect(tickCalls()).toHaveLength(0)
  })

  it('fetch_url: charges the fetch tick, and a refusal never reaches Staan', async () => {
    stubFetch({ results: [{ url: 'https://example.com/', title: 'Page', content: '# Page' }], errors: [] })
    await fetchUrl(undefined, '', 'https://example.com', neverAbort, { virtualKey: 'sk-user-1', chatProvider: null })
    expect(tickCalls().map(c => c[1].model)).toEqual(['web-fetch-tick'])

    litellmCompletion.mockRejectedValueOnce(FREE_POOL_EXHAUSTED)
    const fetchMock = stubFetch({})
    await expect(fetchUrl(undefined, '', 'https://example.com', neverAbort, { virtualKey: 'sk-user-1', chatProvider: aliasProvider }))
      .rejects.toMatchObject({ statusCode: 402, data: { code: 'ai/free-allowance-exhausted' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetch_url: a URL the SSRF guard refuses is not charged', async () => {
    stubFetch({})
    await expect(fetchUrl(undefined, '', 'ftp://example.com/x', neverAbort, { virtualKey: 'sk-user-1' })).rejects.toThrow()
    expect(tickCalls()).toHaveLength(0)
  })
})
