import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubEnv } from '../../helpers/env'
import { resolveWorkerProviders, workerProviderFor, type ResolvedAiProvider } from '../../../server/utils/aiProviders/resolve'
import { readWorkerDefault } from '../../../server/utils/aiProviders/config'
import { providerRequestFields } from '../../../server/utils/aiProviders/requestFields'
import { AiProviderUrlRefused } from '../../../server/utils/aiProviders/urlPolicy'
import { saveAiProviderBody } from '../../../shared/api/account'

// The worker model: delegated rewrites, scans and the web-tool synthesis.
// Resolution: the user's own key (their Fast model, else their chat model)
// → NUXT_AI_DEFAULT_WORKER_* → the chat default; the strong worker only on
// plans with aiStrongModel, only for a platform alias.

const HOSTED_CHAT: ResolvedAiProvider = { capability: 'chat', source: 'instance', model: 'zai-glm-5-3-flash', credentials: null, supportsVision: true }
const SELFHOST_CHAT: ResolvedAiProvider = { capability: 'chat', source: 'instance', model: 'mistral-small-2603', credentials: null, supportsVision: true }
// TEST-NET-3 literal: public, never routed, no DNS needed for the policy check.
const BYOK_CHAT: ResolvedAiProvider = {
  capability: 'chat',
  source: 'user',
  model: 'gpt-5.4-mini',
  credentials: { baseUrl: 'https://93.184.215.14/v1', apiKey: 'sk-user-own' },
  supportsVision: true
}

const WORKER_ENV_KEYS = [
  'NUXT_AI_DEFAULT_WORKER_MODEL', 'NUXT_AI_DEFAULT_WORKER_BASE_URL', 'NUXT_AI_DEFAULT_WORKER_API_KEY', 'NUXT_AI_DEFAULT_WORKER_STRONG_MODEL',
  'TIER_FREE_FEATURE_AI_STRONG_MODEL', 'TIER_PRO_FEATURE_AI_STRONG_MODEL', 'NUXT_AI_BYOK_ALLOWED_BASE_URLS', 'NUXT_AI_BYOK_ALLOW_PRIVATE_URLS'
]

beforeEach(() => {
  for (const k of WORKER_ENV_KEYS) vi.stubEnv(k, '')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

/** The hosted shape (infra/render-env.sh): worker aliases, strong model locked for the free tier. */
function hosted(): void {
  stubEnv({
    NUXT_AI_DEFAULT_WORKER_MODEL: 'markoto-worker',
    NUXT_AI_DEFAULT_WORKER_STRONG_MODEL: 'markoto-worker-strong',
    TIER_FREE_FEATURE_AI_STRONG_MODEL: 'false',
    TIER_PRO_FEATURE_AI_STRONG_MODEL: 'true'
  })
}

describe('resolveWorkerProviders', () => {
  it('no chat provider → no worker', () => {
    hosted()
    expect(resolveWorkerProviders({ chat: null, fastModel: null, plan: 'pro' })).toBeNull()
  })

  it('hosted free: the markoto-worker alias for every mode, no strong worker', () => {
    hosted()
    const worker = resolveWorkerProviders({ chat: HOSTED_CHAT, fastModel: null, plan: 'free' })
    expect(worker?.fast).toEqual({ capability: 'chat', source: 'instance', model: 'markoto-worker', credentials: null, supportsVision: false })
    expect(worker?.strong.model).toBe('markoto-worker')
    expect(workerProviderFor({ worker }, 'translate')?.model).toBe('markoto-worker')
  })

  it('hosted plan with aiStrongModel: translate / rewrite on markoto-worker-strong, the rest on markoto-worker', () => {
    hosted()
    const worker = resolveWorkerProviders({ chat: HOSTED_CHAT, fastModel: null, plan: 'pro' })
    const providers = { worker }
    expect(workerProviderFor(providers, 'translate')?.model).toBe('markoto-worker-strong')
    expect(workerProviderFor(providers, 'rewrite')?.model).toBe('markoto-worker-strong')
    expect(workerProviderFor(providers, { strong: true })?.model).toBe('markoto-worker-strong')
    for (const mode of ['scan', 'terminology', 'summarise', 'comment', 'utility'] as const) {
      expect(workerProviderFor(providers, mode)?.model, mode).toBe('markoto-worker')
    }
    expect(workerProviderFor(providers, { strong: false })?.model).toBe('markoto-worker')
    // Platform aliases: debit the budget, no clientside credentials.
    expect(workerProviderFor(providers, 'translate')?.credentials).toBeNull()
  })

  it('BYOK with a Fast model: the fast model on the same endpoint and key; strong = their chat model', () => {
    hosted()
    const worker = resolveWorkerProviders({ chat: BYOK_CHAT, fastModel: 'gpt-5.4-nano', plan: 'pro' })
    expect(worker?.fast).toEqual({ ...BYOK_CHAT, model: 'gpt-5.4-nano', supportsVision: false })
    expect(worker?.fast.credentials).toBe(BYOK_CHAT.credentials)
    // Never a platform-paid model for a user on their own key, also not the strong alias.
    expect(worker?.strong).toBe(BYOK_CHAT)
  })

  it('BYOK without a Fast model: the chat model for everything', () => {
    hosted()
    const worker = resolveWorkerProviders({ chat: BYOK_CHAT, fastModel: null, plan: 'pro' })
    expect(worker).toEqual({ fast: BYOK_CHAT, strong: BYOK_CHAT })
    // A fast model equal to the chat model is the chat provider itself.
    expect(resolveWorkerProviders({ chat: BYOK_CHAT, fastModel: 'gpt-5.4-mini', plan: 'free' })?.fast).toBe(BYOK_CHAT)
  })

  it('self-host without worker env: the chat default, whatever the plan', () => {
    // NUXT_AI_DEFAULT_WORKER_STRONG_MODEL keeps its default, but needs a worker alias to apply.
    vi.stubEnv('NUXT_AI_DEFAULT_WORKER_STRONG_MODEL', undefined)
    const worker = resolveWorkerProviders({ chat: SELFHOST_CHAT, fastModel: null, plan: 'free' })
    expect(worker).toEqual({ fast: SELFHOST_CHAT, strong: SELFHOST_CHAT })
  })

  it('self-host with a worker alias: the alias, and the strong worker on the self-host free tier (every feature on)', () => {
    stubEnv({ NUXT_AI_DEFAULT_WORKER_MODEL: 'markoto-worker', NUXT_AI_DEFAULT_WORKER_STRONG_MODEL: undefined })
    const worker = resolveWorkerProviders({ chat: SELFHOST_CHAT, fastModel: null, plan: 'free' })
    expect(worker?.fast.model).toBe('markoto-worker')
    expect(worker?.strong.model).toBe('markoto-worker-strong')
  })

  it('self-host with a worker endpoint: clientside credentials, no strong alias swapped in', () => {
    stubEnv({
      NUXT_AI_DEFAULT_WORKER_MODEL: 'qwen3:8b',
      NUXT_AI_DEFAULT_WORKER_BASE_URL: 'http://ollama:11434/v1/',
      NUXT_AI_DEFAULT_WORKER_API_KEY: 'ollama'
    })
    const worker = resolveWorkerProviders({ chat: SELFHOST_CHAT, fastModel: null, plan: 'free' })
    expect(worker?.fast).toEqual({ capability: 'chat', source: 'instance', model: 'qwen3:8b', credentials: { baseUrl: 'http://ollama:11434/v1', apiKey: 'ollama' }, supportsVision: false })
    expect(worker?.strong).toBe(worker?.fast)
  })

  it('a half-configured worker endpoint (no key) is ignored: the chat default', () => {
    stubEnv({ NUXT_AI_DEFAULT_WORKER_MODEL: 'qwen3:8b', NUXT_AI_DEFAULT_WORKER_BASE_URL: 'http://ollama:11434/v1' })
    expect(readWorkerDefault()).toBeNull()
    expect(resolveWorkerProviders({ chat: SELFHOST_CHAT, fastModel: null, plan: 'free' })?.fast).toBe(SELFHOST_CHAT)
  })

  it('workerProviderFor without a worker is null', () => {
    expect(workerProviderFor({ worker: null }, 'utility')).toBeNull()
  })
})

describe('the Fast model shares the chat provider\'s URL policy', () => {
  it('the save body has no URL or key of its own for the fast model', () => {
    const parsed = saveAiProviderBody.parse({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4-mini',
      fastModel: 'gpt-5.4-nano',
      fastBaseUrl: 'http://169.254.169.254/v1',
      fastApiKey: 'sk-other'
    })
    expect(parsed).toEqual({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini', fastModel: 'gpt-5.4-nano' })
    expect(saveAiProviderBody.safeParse({ baseUrl: 'https://x.test/v1', model: 'm', fastModel: 'bad model id' }).success).toBe(false)
    expect(saveAiProviderBody.parse({ baseUrl: 'https://x.test/v1', model: 'm', fastModel: '' }).fastModel).toBe('')
  })

  it('a BYOK worker is re-checked against the BYOK URL policy on every request, like the chat model', async () => {
    const worker = resolveWorkerProviders({ chat: BYOK_CHAT, fastModel: 'gpt-5.4-nano', plan: 'free' })
    if (!worker) throw new Error('expected a worker')
    await expect(providerRequestFields(worker.fast)).resolves.toEqual({ model: 'byok/gpt-5.4-nano', api_key: 'sk-user-own', api_base: 'https://93.184.215.14/v1' })
    // An allowlist that excludes the chat endpoint refuses the fast model too.
    vi.stubEnv('NUXT_AI_BYOK_ALLOWED_BASE_URLS', 'https://api.openai.com/v1')
    await expect(providerRequestFields(worker.fast)).rejects.toBeInstanceOf(AiProviderUrlRefused)
    // A chat endpoint on an internal address refuses the fast model as well.
    const internal: ResolvedAiProvider = { ...BYOK_CHAT, credentials: { baseUrl: 'http://169.254.169.254/v1', apiKey: 'sk' } }
    vi.stubEnv('NUXT_AI_BYOK_ALLOWED_BASE_URLS', '')
    const internalWorker = resolveWorkerProviders({ chat: internal, fastModel: 'gpt-5.4-nano', plan: 'free' })
    if (!internalWorker) throw new Error('expected a worker')
    await expect(providerRequestFields(internalWorker.fast)).rejects.toBeInstanceOf(AiProviderUrlRefused)
  })
})
