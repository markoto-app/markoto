import { describe, it, expect, beforeEach, vi } from 'vitest'

// Embeddings wrapper. Phase 5 reduced this to a single backend (Jina
// via LiteLLM). The shape of `embedDocuments` / `embedQuery` /
// `embeddingVersionTag` is the public contract that
// processKnowledge.ts and the re-embed script depend on.

const mockState = vi.hoisted(() => ({
  config: {
    litellm: {
      url: 'http://litellm:4000',
      masterKey: 'sk-master',
      embeddingsModel: 'jina-embeddings-v5-text-nano',
      embeddingsDims: 768
    }
  },
  jinaCalls: [] as Array<Record<string, unknown>>,
  jinaResponse: { data: [{ embedding: new Array(768).fill(0.01) }] } as unknown
}))

;(globalThis as unknown as { useRuntimeConfig: () => typeof mockState.config }).useRuntimeConfig = () => mockState.config

vi.mock('../../server/utils/litellmClient', () => ({
  useLitellmAdmin: () => ({
    embeddings: {
      create: async (req: Record<string, unknown>) => {
        mockState.jinaCalls.push(req)
        return mockState.jinaResponse
      }
    }
  })
}))

const {
  resolveEmbeddingsConfig,
  embeddingVersionTag,
  embedDocuments,
  embedQuery
} = await import('../../server/utils/embeddings')

beforeEach(() => {
  mockState.jinaCalls = []
  mockState.config = {
    litellm: {
      url: 'http://litellm:4000',
      masterKey: 'sk-master',
      embeddingsModel: 'jina-embeddings-v5-text-nano',
      embeddingsDims: 768
    }
  }
  mockState.jinaResponse = { data: [{ embedding: new Array(768).fill(0.01) }] }
})

// ─── resolveEmbeddingsConfig + embeddingVersionTag ────────────────────────

describe('resolveEmbeddingsConfig', () => {
  it('resolves the jina config from runtimeConfig', () => {
    const cfg = resolveEmbeddingsConfig()
    expect(cfg.provider).toBe('jina')
    expect(cfg.model).toBe('jina-embeddings-v5-text-nano')
    expect(cfg.dimensions).toBe(768)
    expect(cfg.apiKey).toBe('sk-master')
  })

  it('throws when NUXT_LITELLM_MASTER_KEY is missing', () => {
    mockState.config.litellm.masterKey = ''
    expect(() => resolveEmbeddingsConfig()).toThrow(/NUXT_LITELLM_MASTER_KEY/)
  })
})

describe('embeddingVersionTag', () => {
  it('emits {provider}/{model}:{dims}', () => {
    expect(embeddingVersionTag({
      provider: 'jina',
      model: 'jina-embeddings-v5-text-nano',
      dimensions: 768,
      apiKey: 'k'
    })).toBe('jina/jina-embeddings-v5-text-nano:768')
  })
})

// ─── embedDocuments — wire-format ─────────────────────────────────────────

describe('embedDocuments', () => {
  it('passes task=retrieval.passage and dimensions=768 to LiteLLM', async () => {
    await embedDocuments(['hello world'])
    expect(mockState.jinaCalls).toHaveLength(1)
    const call = mockState.jinaCalls[0]!
    expect(call.model).toBe('jina-embeddings-v5-text-nano')
    expect(call.dimensions).toBe(768)
    expect(call.task).toBe('retrieval.passage')
    expect(call.input).toBe('hello world')
  })

  it('returns one vector per input, all 768-d', async () => {
    const out = await embedDocuments(['a', 'b', 'c', 'd', 'e'])
    expect(out).toHaveLength(5)
    out.forEach(v => expect(v.length).toBe(768))
    expect(mockState.jinaCalls).toHaveLength(5)
  })

  it('truncates inputs longer than MAX_INPUT_CHARS', async () => {
    const huge = 'x'.repeat(20_000)
    await embedDocuments([huge])
    const call = mockState.jinaCalls[0]!
    expect(typeof call.input).toBe('string')
    expect((call.input as string).length).toBeLessThanOrEqual(8000)
  })

  it('throws on wrong-shape vector', async () => {
    mockState.jinaResponse = { data: [{ embedding: new Array(512).fill(0) }] }
    await expect(embedDocuments(['x'])).rejects.toThrow(/wrong shape/)
  })
})

// ─── embedQuery — single-call query path ──────────────────────────────────

describe('embedQuery', () => {
  it('uses task=retrieval.query', async () => {
    await embedQuery('what is markoto')
    const call = mockState.jinaCalls[0]!
    expect(call.task).toBe('retrieval.query')
  })
})
