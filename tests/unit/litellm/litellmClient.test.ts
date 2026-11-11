import { describe, it, expect, beforeEach, vi } from 'vitest'

// litellmClient.ts is a thin OpenAI SDK factory pointed at the LiteLLM
// proxy. The unit-level value is small (the SDK does the work), but the
// factory has three behaviors worth pinning:
//   1. URL is normalized — trailing slashes stripped, /v1 appended.
//   2. Master-key path caches across calls.
//   3. Per-user-key path returns a fresh client per call.

const mockState = vi.hoisted(() => ({
  config: {
    litellm: {
      url: 'http://litellm:4000',
      masterKey: 'sk-master-test-key',
      embeddingsModel: 'jina-embeddings-v5-text-nano',
      embeddingsDims: 768
    }
  }
}))

vi.mock('#imports', () => ({
  useRuntimeConfig: () => mockState.config
}))

// The factory uses Nuxt's auto-imported `useRuntimeConfig`; we provide
// our own globally so the OpenAI SDK constructor is exercised against
// known values without booting Nitro.
;(globalThis as unknown as { useRuntimeConfig: () => typeof mockState.config }).useRuntimeConfig = () => mockState.config

const { useLitellmAdmin, useLitellmForUser, _resetLitellmCache } = await import('../../../server/utils/ai/litellmClient')

beforeEach(() => {
  _resetLitellmCache()
  mockState.config = {
    litellm: {
      url: 'http://litellm:4000',
      masterKey: 'sk-master-test-key',
      embeddingsModel: 'jina-embeddings-v5-text-nano',
      embeddingsDims: 768
    }
  }
})

describe('useLitellmAdmin', () => {
  it('returns an OpenAI client with /v1 appended to the configured base URL', () => {
    const client = useLitellmAdmin()
    // The OpenAI SDK exposes baseURL on the instance.
    expect(client.baseURL).toBe('http://litellm:4000/v1')
    expect(client.apiKey).toBe('sk-master-test-key')
  })

  it('strips trailing slashes from the URL before joining /v1', () => {
    mockState.config.litellm.url = 'http://litellm:4000/'
    const client = useLitellmAdmin()
    expect(client.baseURL).toBe('http://litellm:4000/v1')
  })

  it('caches the client across calls (singleton)', () => {
    const a = useLitellmAdmin()
    const b = useLitellmAdmin()
    expect(a).toBe(b)
  })

  it('throws when NUXT_LITELLM_URL is missing', () => {
    mockState.config.litellm.url = ''
    expect(() => useLitellmAdmin()).toThrow(/NUXT_LITELLM_URL/)
  })

  it('throws when NUXT_LITELLM_MASTER_KEY is missing', () => {
    mockState.config.litellm.masterKey = ''
    expect(() => useLitellmAdmin()).toThrow(/NUXT_LITELLM_MASTER_KEY/)
  })
})

describe('useLitellmForUser', () => {
  it('returns a new client per call (no cache)', () => {
    const a = useLitellmForUser('sk-user-1')
    const b = useLitellmForUser('sk-user-1')
    expect(a).not.toBe(b) // distinct instances per call
    expect(a.apiKey).toBe('sk-user-1')
  })

  it('uses the per-user key, not the master key', () => {
    const client = useLitellmForUser('sk-virtual-abc')
    expect(client.apiKey).toBe('sk-virtual-abc')
    expect(client.apiKey).not.toBe('sk-master-test-key')
  })

  it('still throws when NUXT_LITELLM_URL is missing', () => {
    mockState.config.litellm.url = ''
    expect(() => useLitellmForUser('sk-virtual')).toThrow(/NUXT_LITELLM_URL/)
  })
})
