import { describe, it, expect, beforeEach, vi } from 'vitest'
import { stubEnv } from '../../helpers/env'

// Embeddings wrapper over a single backend (Jina
// via LiteLLM). The shape of `embedDocuments` / `embedQuery` /
// `embeddingVersionTag` is the public contract that
// processKnowledge.ts and the re-embed script depend on.

const mockState = vi.hoisted(() => ({
  jinaCalls: [] as Array<Record<string, unknown>>,
  jinaResponse: { data: [{ embedding: new Array(768).fill(0.01) }] } as unknown
}))

// Configuration comes from the typed env (shared/env), stubbed per test.
const JINA_ENV = {
  NUXT_LITELLM_URL: 'http://litellm:4000',
  NUXT_LITELLM_MASTER_KEY: 'sk-master',
  NUXT_LITELLM_EMBEDDINGS_MODEL: 'jina-embeddings-v5-text-nano',
  NUXT_LITELLM_EMBEDDINGS_DIMS: '768'
}

vi.mock('../../../server/utils/ai/litellmClient', () => ({
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
} = await import('../../../server/utils/knowledge/embeddings')

beforeEach(() => {
  mockState.jinaCalls = []
  stubEnv(JINA_ENV)
  mockState.jinaResponse = { data: [{ embedding: new Array(768).fill(0.01) }] }
})

// resolveEmbeddingsConfig + embeddingVersionTag

describe('resolveEmbeddingsConfig', () => {
  it('resolves the jina config from the environment', () => {
    const cfg = resolveEmbeddingsConfig()
    expect(cfg.provider).toBe('jina')
    expect(cfg.model).toBe('jina-embeddings-v5-text-nano')
    expect(cfg.dimensions).toBe(768)
    expect(cfg.apiKey).toBe('sk-master')
  })

  it('throws when NUXT_LITELLM_MASTER_KEY is missing', () => {
    stubEnv({ NUXT_LITELLM_MASTER_KEY: undefined })
    expect(() => resolveEmbeddingsConfig()).toThrow(/NUXT_LITELLM_MASTER_KEY/)
  })
})

describe('embeddingVersionTag', () => {
  it('emits {provider}/{model}:{dims}', () => {
    expect(embeddingVersionTag({
      provider: 'jina',
      model: 'jina-embeddings-v5-text-nano',
      upstreamModel: '',
      dimensions: 768,
      shape: { sendTaskHint: true, sendDimensions: true },
      apiKey: 'k'
    })).toBe('jina/jina-embeddings-v5-text-nano:768')
  })

  it('uses the upstream model for a custom deployment when known', () => {
    const base = {
      provider: 'custom' as const,
      model: 'custom-embeddings',
      dimensions: 1536,
      shape: { sendTaskHint: false, sendDimensions: false },
      apiKey: 'k'
    }
    expect(embeddingVersionTag({ ...base, upstreamModel: 'openai/text-embedding-3-small' }))
      .toBe('custom/openai/text-embedding-3-small:1536')
    expect(embeddingVersionTag({ ...base, upstreamModel: '' })).toBe('custom/custom-embeddings:1536')
  })
})

describe('custom (non-Jina) configuration', () => {
  function useCustom(extra: Record<string, string> = {}, dims = 1536): void {
    stubEnv({ ...JINA_ENV, NUXT_LITELLM_EMBEDDINGS_MODEL: 'custom-embeddings', NUXT_LITELLM_EMBEDDINGS_DIMS: String(dims), ...extra })
    mockState.jinaResponse = { data: [{ embedding: new Array(dims).fill(0.01) }] }
  }

  it('resolves provider=custom and sends neither task nor dimensions by default', async () => {
    useCustom()
    expect(resolveEmbeddingsConfig().provider).toBe('custom')
    await embedDocuments(['hello'])
    await embedQuery('hello')
    for (const call of mockState.jinaCalls) {
      expect(call).not.toHaveProperty('task')
      expect(call).not.toHaveProperty('dimensions')
      expect(call.model).toBe('custom-embeddings')
    }
  })

  it('sends dimensions when the operator opts in', async () => {
    useCustom({ NUXT_LITELLM_EMBEDDINGS_SEND_DIMENSIONS: 'true' })
    await embedDocuments(['hello'])
    expect(mockState.jinaCalls[0]!.dimensions).toBe(1536)
    expect(mockState.jinaCalls[0]).not.toHaveProperty('task')
  })

  it('sends the task hint when the operator opts in', async () => {
    useCustom({ NUXT_LITELLM_EMBEDDINGS_TASK_HINTS: 'true' })
    await embedQuery('hello')
    expect(mockState.jinaCalls[0]!.task).toBe('retrieval.query')
  })

  it('still rejects a vector of the wrong length with an actionable message', async () => {
    useCustom()
    mockState.jinaResponse = { data: [{ embedding: new Array(768).fill(0) }] }
    await expect(embedDocuments(['x'])).rejects.toThrow(/NUXT_LITELLM_EMBEDDINGS_DIMS=1536/)
  })

  it('rejects dimensions beyond the HNSW limit', () => {
    useCustom({}, 3072)
    expect(() => resolveEmbeddingsConfig()).toThrow(/NUXT_LITELLM_EMBEDDINGS_DIMS: expected an integer 1–2000/)
  })
})

// embedDocuments — wire-format

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

// embedQuery — single-call query path

describe('embedQuery', () => {
  it('uses task=retrieval.query', async () => {
    await embedQuery('what is markoto')
    const call = mockState.jinaCalls[0]!
    expect(call.task).toBe('retrieval.query')
  })
})
