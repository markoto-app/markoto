import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ResolvedAiProvider } from '../../../server/utils/aiProviders/resolve'

// EU only: every Mistral call the platform pays goes to Mistral's EU
// regional endpoint `api.eu.mistral.ai` (the global `api.mistral.ai`
// makes no location commitment), the LiteLLM deployments, the Voxtral
// transcription handler and the live-dictation WebSocket on the
// operator's key. A user's own Mistral key streams to the host the user
// configured.

const constructed: Array<Record<string, unknown>> = []
vi.mock('@mistralai/mistralai/extra/realtime', () => ({
  AudioEncoding: { PcmS16le: 'pcm_s16le' },
  RealtimeTranscription: class {
    constructor(opts: Record<string, unknown>) {
      constructed.push(opts)
    }

    // Test double: a stream that ends at once.
    async* transcribeStream() {
      yield* []
    }
  }
}))

const ROOT = resolve(__dirname, '../../..')

afterEach(() => {
  vi.unstubAllEnvs()
  constructed.length = 0
})

function transcription(baseUrl: string | null): ResolvedAiProvider {
  return {
    capability: 'transcription',
    source: baseUrl ? 'user' : 'instance',
    model: 'voxtral-mini-2602',
    credentials: baseUrl ? { baseUrl, apiKey: 'sk-user' } : null,
    supportsVision: false
  }
}

describe('live dictation target', () => {
  it('operator-paid dictation always streams to the EU endpoint', async () => {
    vi.stubEnv('MISTRAL_API_KEY', 'sk-operator')
    const { liveDictationTarget } = await import('../../../server/utils/aiProviders/resolve')
    expect(liveDictationTarget(transcription(null))).toMatchObject({ serverURL: 'https://api.eu.mistral.ai', platformBilled: true })
  })

  it('a user\'s own Mistral key streams to the host they configured (global or EU)', async () => {
    const { liveDictationTarget } = await import('../../../server/utils/aiProviders/resolve')
    expect(liveDictationTarget(transcription('https://api.mistral.ai/v1'))).toMatchObject({ serverURL: 'https://api.mistral.ai', platformBilled: false })
    expect(liveDictationTarget(transcription('https://api.eu.mistral.ai/v1'))).toMatchObject({ serverURL: 'https://api.eu.mistral.ai', platformBilled: false })
  })

  it('other providers never unlock live dictation', async () => {
    const { liveDictationTarget } = await import('../../../server/utils/aiProviders/resolve')
    expect(liveDictationTarget(transcription('https://api.openai.com/v1'))).toBeNull()
  })
})

describe('realtime client', () => {
  it('passes the server URL to the Mistral SDK, the EU endpoint by default (the SDK\'s own default is global)', async () => {
    // The CI coverage job runs with TEST_MODE=1 + NUXT_VOXTRAL_REALTIME_MOCK=1,
    // which makes the factory return the canned mock client (it never
    // constructs the SDK and never ends on its own). This test is about
    // the real client, so switch the mocks off for it.
    vi.stubEnv('NUXT_VOXTRAL_REALTIME_MOCK', '')
    const { createDictateRealtimeClient } = await import('../../../server/utils/agentic/dictateSpeechClient')
    const req = { config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'en-US' }, interimResults: true }
    const ended = (stream: ReturnType<ReturnType<typeof createDictateRealtimeClient>['streamingRecognize']>) =>
      new Promise<void>(r => stream.on('end', () => r()))

    const a = createDictateRealtimeClient('sk-operator', 'voxtral-mini-transcribe-realtime-2602').streamingRecognize(req)
    await ended(a)
    const b = createDictateRealtimeClient('sk-user', 'voxtral-mini-transcribe-realtime-2602', 'https://api.mistral.ai').streamingRecognize(req)
    await ended(b)
    expect(constructed.map(o => o.serverURL)).toEqual(['https://api.eu.mistral.ai', 'https://api.mistral.ai'])
  })
})

describe('LiteLLM: every Mistral deployment is EU-pinned', () => {
  const config = readFileSync(resolve(ROOT, 'deploy/config/litellm/config.yaml'), 'utf8')
  const handlers = readFileSync(resolve(ROOT, 'deploy/config/litellm/custom_handlers.py'), 'utf8')

  it('each `mistral/…` deployment carries api_base = the EU endpoint', () => {
    const blocks = config.split(/\n {2}- model_name: /).slice(1)
    const mistral = blocks.filter(b => /\n {6}model: mistral\//.test(b))
    expect(mistral.length).toBeGreaterThanOrEqual(3)
    for (const block of mistral) {
      expect(block, block.split('\n')[0]).toMatch(/\n {6}api_base: https:\/\/api\.eu\.mistral\.ai\/v1\n/)
    }
  })

  it('the knowledge-base embeddings (mistral-embed, the default) run on the EU endpoint with the operator key', () => {
    const block = (config.split(/\n {2}- model_name: /).find(b => b.startsWith('mistral-embed\n')) ?? '')
      .split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    expect(block).toMatch(/\n {6}model: mistral\/mistral-embed-2312\n/)
    expect(block).toMatch(/\n {6}api_base: https:\/\/api\.eu\.mistral\.ai\/v1\n/)
    expect(block).toMatch(/\n {6}api_key: os\.environ\/MISTRAL_API_KEY\n/)
    // Spend is recorded from usage.prompt_tokens at the EU price (1.1 x $0.10 / M).
    expect(block).toMatch(/\n {6}input_cost_per_token: 0\.00000011\b/)
    expect(config).not.toMatch(/jina/i)
  })

  it('thinking is off on the free-allowance model and its fallback, each set at the proxy for every caller', () => {
    // YAML of one deployment, comments dropped (the next entry's header
    // comment would otherwise count as part of this one).
    const block = (name: string) => (config.split(/\n {2}- model_name: /).find(b => b.startsWith(`${name}\n`)) ?? '')
      .split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    // The hosted chat default (DeepSeek V4.1 Flash): `none`, which GLM
    // would refuse, so it is a deployment param and never travels with a
    // request to the GLM fallback.
    // GLM-5.3 Flash: Mistral accepts low / high / max only; `low` is the
    // "off" switch (0 reasoning tokens on almost every turn, verified live).
    expect(block('zai-glm-5-3-flash')).toMatch(/\n {6}reasoning_effort: low\n/)
    expect(block('deepseek-v4-1-flash-1017')).toMatch(/\n {6}reasoning_effort: none\n/)
    expect(config).toMatch(/- zai-glm-5-3-flash: \[deepseek-v4-1-flash-1017\]/)
    expect(config).toMatch(/- deepseek-v4-1-flash-1017: \[zai-glm-5-3-flash\]/)
  })

  it('the Voxtral transcription handler posts to the EU endpoint', () => {
    expect(handlers).toContain('_MISTRAL_TRANSCRIBE_API = "https://api.eu.mistral.ai/v1/audio/transcriptions"')
    expect(handlers).not.toMatch(/https:\/\/api\.mistral\.ai/)
  })
})
