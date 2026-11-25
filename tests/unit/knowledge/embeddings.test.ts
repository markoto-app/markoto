import { describe, it, expect, beforeEach, vi } from 'vitest'
import { stubEnv } from '../../helpers/env'

// Embeddings wrapper over a single backend (the `mistral-embed` deployment
// via LiteLLM by default). The shape of `embedDocuments` / `embedQuery` /
// `embeddingVersionTag` is the public contract that processKnowledge.ts and
// the re-embed script depend on.

const mockState = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  response: { data: [{ embedding: new Array(1024).fill(0.01) }] } as unknown
}))

// Configuration comes from the typed env (shared/env), stubbed per test.
const DEFAULT_ENV = {
  NUXT_LITELLM_URL: 'http://litellm:4000',
  NUXT_LITELLM_MASTER_KEY: 'sk-master',
  NUXT_LITELLM_EMBEDDINGS_MODEL: undefined,
  NUXT_LITELLM_EMBEDDINGS_DIMS: undefined,
  NUXT_LITELLM_EMBEDDINGS_SEND_DIMENSIONS: undefined,
  NUXT_LITELLM_EMBEDDINGS_TASK_HINTS: undefined
}

vi.mock('../../../server/utils/ai/litellmClient', () => ({
  useLitellmAdmin: () => ({
    embeddings: {
      create: async (req: Record<string, unknown>) => {
        mockState.calls.push(req)
        return mockState.response
      }
    }
  })
}))

const {
  MAX_INPUT_BYTES,
  resolveEmbeddingsConfig,
  embeddingVersionTag,
  embedDocuments,
  embedQuery,
  truncateForEmbedding
} = await import('../../../server/utils/knowledge/embeddings')

beforeEach(() => {
  mockState.calls = []
  stubEnv(DEFAULT_ENV)
  mockState.response = { data: [{ embedding: new Array(1024).fill(0.01) }] }
})

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length

// resolveEmbeddingsConfig + embeddingVersionTag

describe('resolveEmbeddingsConfig', () => {
  it('defaults to mistral-embed at 1024 dimensions, with no extra request fields', () => {
    const cfg = resolveEmbeddingsConfig()
    expect(cfg.provider).toBe('mistral')
    expect(cfg.model).toBe('mistral-embed')
    expect(cfg.dimensions).toBe(1024)
    expect(cfg.shape).toEqual({ sendTaskHint: false, sendDimensions: false })
    expect(cfg.apiKey).toBe('sk-master')
  })

  it('throws when NUXT_LITELLM_MASTER_KEY is missing', () => {
    stubEnv({ NUXT_LITELLM_MASTER_KEY: undefined })
    expect(() => resolveEmbeddingsConfig()).toThrow(/NUXT_LITELLM_MASTER_KEY/)
  })
})

describe('embeddingVersionTag', () => {
  it('emits {provider}/{model}:{dims}', () => {
    expect(embeddingVersionTag(resolveEmbeddingsConfig())).toBe('mistral/mistral-embed:1024')
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

describe('custom configuration', () => {
  function useCustom(extra: Record<string, string> = {}, dims = 1536): void {
    stubEnv({ ...DEFAULT_ENV, NUXT_LITELLM_EMBEDDINGS_MODEL: 'custom-embeddings', NUXT_LITELLM_EMBEDDINGS_DIMS: String(dims), ...extra })
    mockState.response = { data: [{ embedding: new Array(dims).fill(0.01) }] }
  }

  it('resolves provider=custom and sends neither task nor dimensions by default', async () => {
    useCustom()
    expect(resolveEmbeddingsConfig().provider).toBe('custom')
    await embedDocuments(['hello'])
    await embedQuery('hello')
    for (const call of mockState.calls) {
      expect(call).not.toHaveProperty('task')
      expect(call).not.toHaveProperty('dimensions')
      expect(call.model).toBe('custom-embeddings')
    }
  })

  it('sends dimensions when the operator opts in', async () => {
    useCustom({ NUXT_LITELLM_EMBEDDINGS_SEND_DIMENSIONS: 'true' })
    await embedDocuments(['hello'])
    expect(mockState.calls[0]!.dimensions).toBe(1536)
    expect(mockState.calls[0]).not.toHaveProperty('task')
  })

  it('sends the task hint when the operator opts in', async () => {
    useCustom({ NUXT_LITELLM_EMBEDDINGS_TASK_HINTS: 'true' })
    await embedQuery('hello')
    await embedDocuments(['hello'])
    expect(mockState.calls[0]!.task).toBe('retrieval.query')
    expect(mockState.calls[1]!.task).toBe('retrieval.passage')
  })

  it('still rejects a vector of the wrong length with an actionable message', async () => {
    useCustom()
    mockState.response = { data: [{ embedding: new Array(768).fill(0) }] }
    await expect(embedDocuments(['x'])).rejects.toThrow(/NUXT_LITELLM_EMBEDDINGS_DIMS=1536/)
  })

  it('rejects dimensions beyond the HNSW limit', () => {
    useCustom({}, 3072)
    expect(() => resolveEmbeddingsConfig()).toThrow(/NUXT_LITELLM_EMBEDDINGS_DIMS: expected an integer 1–2000/)
  })
})

// embedDocuments: wire-format

describe('embedDocuments', () => {
  it('asks the mistral-embed deployment for float vectors, with no task or dimensions field', async () => {
    await embedDocuments(['hello world'])
    expect(mockState.calls).toHaveLength(1)
    const call = mockState.calls[0]!
    expect(call.model).toBe('mistral-embed')
    expect(call.encoding_format).toBe('float')
    expect(call).not.toHaveProperty('dimensions')
    expect(call).not.toHaveProperty('task')
    expect(call.input).toBe('hello world')
  })

  it('returns one vector per input, all 1024-d', async () => {
    const out = await embedDocuments(['a', 'b', 'c', 'd', 'e'])
    expect(out).toHaveLength(5)
    out.forEach(v => expect(v.length).toBe(1024))
    expect(mockState.calls).toHaveLength(5)
  })

  it('cuts inputs to MAX_INPUT_BYTES of UTF-8', async () => {
    await embedDocuments(['x'.repeat(20_000)])
    const input = mockState.calls[0]!.input as string
    expect(input.length).toBe(MAX_INPUT_BYTES)
  })

  it('throws on wrong-shape vector', async () => {
    mockState.response = { data: [{ embedding: new Array(512).fill(0) }] }
    await expect(embedDocuments(['x'])).rejects.toThrow(/wrong shape/)
  })
})

// truncateForEmbedding: stays under mistral-embed's 8192-token limit in any script

describe('truncateForEmbedding', () => {
  it('keeps short text untouched', () => {
    expect(truncateForEmbedding('hello')).toBe('hello')
    const fits = 'ü'.repeat(MAX_INPUT_BYTES / 2)
    expect(truncateForEmbedding(fits)).toBe(fits)
  })

  it('cuts multi-byte text by bytes, not characters (CJK: 3 bytes each)', () => {
    const out = truncateForEmbedding('漢'.repeat(5000))
    expect(utf8Bytes(out)).toBeLessThanOrEqual(MAX_INPUT_BYTES)
    expect(out.length).toBe(Math.floor(MAX_INPUT_BYTES / 3))
  })

  it('never splits a surrogate pair (emoji: 4 bytes each)', () => {
    const out = truncateForEmbedding('😀'.repeat(3000))
    expect(utf8Bytes(out)).toBeLessThanOrEqual(MAX_INPUT_BYTES)
    expect(out).toBe('😀'.repeat(MAX_INPUT_BYTES / 4))
  })

  it('stays below the 8192-token input limit of mistral-embed', () => {
    // A byte-level BPE never emits more tokens than bytes.
    expect(MAX_INPUT_BYTES).toBeLessThan(8192)
  })
})

// embedQuery: single-call query path

describe('embedQuery', () => {
  it('sends the query to the default model with no task hint', async () => {
    await embedQuery('what is markoto')
    const call = mockState.calls[0]!
    expect(call.model).toBe('mistral-embed')
    expect(call).not.toHaveProperty('task')
    expect(call.input).toBe('what is markoto')
  })
})
