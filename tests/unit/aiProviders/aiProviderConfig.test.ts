import { describe, it, expect } from 'vitest'
import { instanceDefaultProblems, readInstanceDefault, resolveByokUrlPolicy } from '../../../server/utils/aiProviders/config'
import { AiProviderCallError, PROVIDER_ERROR_MESSAGES, classifyProviderError, providerErrorMessage, redactSecret, withProviderErrors } from '../../../server/utils/aiProviders/requestFields'
import { AiProviderUrlRefused } from '../../../server/utils/aiProviders/urlPolicy'
import type { ResolvedAiProvider } from '../../../server/utils/aiProviders/resolve'
import { filterToolsForProviders, ALL_TOOL_DECLARATIONS } from '../../../server/utils/agentic/functionTools'
import { VERIFY_CODES, apiKeyLast4, normalizeBaseUrl } from '../../../shared/ai/providers'

describe('readInstanceDefault', () => {
  it('no model → no default', () => {
    expect(readInstanceDefault('chat', {})).toBeNull()
    expect(readInstanceDefault('chat', { NUXT_AI_DEFAULT_CHAT_BASE_URL: 'https://x.test/v1', NUXT_AI_DEFAULT_CHAT_API_KEY: 'k' })).toBeNull()
  })

  it('model only → platform alias (no credentials), vision on by default for chat', () => {
    expect(readInstanceDefault('chat', { NUXT_AI_DEFAULT_CHAT_MODEL: 'mistral-small-2603' })).toEqual({
      capability: 'chat', model: 'mistral-small-2603', credentials: null, supportsVision: true
    })
    expect(readInstanceDefault('image', { NUXT_AI_DEFAULT_IMAGE_MODEL: 'flux-2-pro' })?.credentials).toBeNull()
  })

  it('model + base URL + key → clientside credentials (normalised URL)', () => {
    const def = readInstanceDefault('transcription', {
      NUXT_AI_DEFAULT_TRANSCRIBE_MODEL: 'whisper-1',
      NUXT_AI_DEFAULT_TRANSCRIBE_BASE_URL: 'https://api.openai.com/v1/',
      NUXT_AI_DEFAULT_TRANSCRIBE_API_KEY: 'sk-op'
    })
    expect(def).toEqual({
      capability: 'transcription', model: 'whisper-1', credentials: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-op' }, supportsVision: false
    })
  })

  it('base URL without key is treated as unset and reported', () => {
    const env = { NUXT_AI_DEFAULT_CHAT_MODEL: 'm', NUXT_AI_DEFAULT_CHAT_BASE_URL: 'https://x.test/v1' }
    expect(readInstanceDefault('chat', env)).toBeNull()
    expect(instanceDefaultProblems(env).join(' ')).toContain('NUXT_AI_DEFAULT_CHAT_API_KEY')
  })

  it('_VISION=false turns vision off', () => {
    expect(readInstanceDefault('chat', { NUXT_AI_DEFAULT_CHAT_MODEL: 'm', NUXT_AI_DEFAULT_CHAT_VISION: 'false' })?.supportsVision).toBe(false)
  })
})

describe('resolveByokUrlPolicy', () => {
  it('defaults to free-form URLs without private networks', () => {
    expect(resolveByokUrlPolicy({})).toEqual({ allowedBaseUrls: [], allowPrivate: false })
  })
  it('parses + normalises the allowlist and the opt-in', () => {
    expect(resolveByokUrlPolicy({
      NUXT_AI_BYOK_ALLOWED_BASE_URLS: ' https://api.mistral.ai/v1/ , https://api.openai.com/v1,,not a url',
      NUXT_AI_BYOK_ALLOW_PRIVATE_URLS: 'TRUE'
    })).toEqual({ allowedBaseUrls: ['https://api.mistral.ai/v1', 'https://api.openai.com/v1'], allowPrivate: true })
  })
})

describe('redactSecret', () => {
  // Assembled at runtime and low-entropy on purpose: a literal
  // secret-shaped string here trips the gitleaks CI gate.
  const key = ['fixture', 'key', 'aaaa', 'bbbb', 'cccc'].join('-')
  it('removes the full key', () => {
    expect(redactSecret(`Incorrect API key provided: ${key}.`, key)).not.toContain(key)
  })
  it('removes long prefixes and suffixes a provider might echo', () => {
    const head = key.slice(0, 14)
    const tail = key.slice(-9)
    const out = redactSecret(`bad key ${head}**** and …${tail}`, key)
    expect(out).not.toContain(head)
    expect(out).not.toContain(tail)
    expect(out).toContain('[redacted]')
  })
  it('leaves unrelated text alone', () => {
    expect(redactSecret('model not found', key)).toBe('model not found')
  })
})

describe('classifyProviderError', () => {
  it.each([
    [Object.assign(new Error('AuthenticationError: Incorrect API key'), { status: 401 }), 'auth-failed'],
    [Object.assign(new Error('NotFoundError: model does not exist'), { status: 404 }), 'model-not-found'],
    [new Error('connect ECONNREFUSED 10.0.0.1:443'), 'unreachable'],
    [new Error('weird'), 'unexpected-response']
  ])('%s → %s', (err, code) => {
    expect(classifyProviderError(err)).toBe(code)
  })
})

// Regression (BYOK error echo): a provider URL that redirected the proxy
// to an internal service got that service's body back in the error text
// ("Received: '<internal body>'"), which verification and the agent loop
// showed to the user. Upstream text must never reach the user.
describe('provider error messages carry no upstream text', () => {
  const user: ResolvedAiProvider = {
    capability: 'chat',
    source: 'user',
    model: 'm',
    credentials: { baseUrl: 'https://llm.example.com/v1', apiKey: ['fixture', 'key', 'dddd', 'eeee'].join('-') },
    supportsVision: false
  }
  const leak = 'INTERNAL-SECRET-BODY'

  it.each([
    [Object.assign(new Error(`InternalServerError: OpenAIException - Empty or invalid response from LLM endpoint. Received: '${leak}'`), { status: 500 })],
    [Object.assign(new Error(`AuthenticationError: ${leak}`), { status: 401 })],
    [new Error(`APIConnectionError: connection refused ${leak}`)]
  ])('withProviderErrors hides the upstream message (%#)', async (upstream) => {
    const err = await withProviderErrors(user, async () => {
      throw upstream
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AiProviderCallError)
    expect(String(err instanceof Error ? err.message : err)).not.toContain(leak)
  })

  it('names a redirect without echoing the redirect target', () => {
    const e = Object.assign(new Error('APIError: OpenAIException - Error code: 302'), { status: 500 })
    const message = providerErrorMessage(classifyProviderError(e), e)
    expect(message).toMatch(/redirect/i)
    expect(message).not.toContain('302')
  })

  it('keeps our own URL-policy text (it says what to fix)', () => {
    const e = new AiProviderUrlRefused('private-address', 'This URL points at a private network address, which this instance does not allow.')
    expect(providerErrorMessage('url-refused', e)).toBe(e.message)
  })

  it('every code has a fixed message', () => {
    for (const code of VERIFY_CODES) expect(PROVIDER_ERROR_MESSAGES[code].length).toBeGreaterThan(0)
  })
})

describe('filterToolsForProviders', () => {
  const names = (decls: typeof ALL_TOOL_DECLARATIONS) => decls.map(d => d.name)
  it('keeps everything with a vision chat model + image provider', () => {
    const out = filterToolsForProviders(ALL_TOOL_DECLARATIONS, { chat: { supportsVision: true }, image: {} })
    expect(out).toHaveLength(ALL_TOOL_DECLARATIONS.length)
  })
  it('drops generate_image without an image provider', () => {
    const out = names(filterToolsForProviders(ALL_TOOL_DECLARATIONS, { chat: { supportsVision: true }, image: null }))
    expect(out).not.toContain('generate_image')
    expect(out).toContain('view_image')
  })
  it('drops the image-INPUT tools for a text-only chat model', () => {
    const out = names(filterToolsForProviders(ALL_TOOL_DECLARATIONS, { chat: { supportsVision: false }, image: {} }))
    expect(out).not.toContain('view_image')
    expect(out).not.toContain('view_pages')
    expect(out).toContain('generate_image')
    expect(out).toContain('insert_text')
  })
  it('drops web_search / fetch_url independently when the operator has no Staan / Jina key', () => {
    const providers = { chat: { supportsVision: true }, image: {} }
    const noSearch = names(filterToolsForProviders(ALL_TOOL_DECLARATIONS, providers, { search: false, fetch: true }))
    expect(noSearch).not.toContain('web_search')
    expect(noSearch).toContain('fetch_url')
    const noFetch = names(filterToolsForProviders(ALL_TOOL_DECLARATIONS, providers, { search: true, fetch: false }))
    expect(noFetch).toContain('web_search')
    expect(noFetch).not.toContain('fetch_url')
  })
})

describe('display helpers', () => {
  it('apiKeyLast4 shows only the tail', () => {
    expect(apiKeyLast4('sk-abcdef1234')).toBe('1234')
    expect(apiKeyLast4('abc')).toBe('•••')
  })
  it('normalizeBaseUrl trims trailing slashes and rejects non-URLs', () => {
    expect(normalizeBaseUrl('https://API.example.com/v1//')).toBe('https://api.example.com/v1')
    expect(normalizeBaseUrl('nope')).toBeNull()
  })
})
