import { describe, it, expect } from 'vitest'
import {
  DEFAULT_EMBEDDINGS_DIMS,
  DEFAULT_EMBEDDINGS_MODEL,
  MAX_EMBEDDING_DIMS,
  embeddingRequestParams,
  parseEmbeddingDims,
  parseTriState,
  resolveRequestShape
} from '../../../shared/utils/runtime/embeddingConfig'

describe('parseEmbeddingDims', () => {
  it('accepts integers and numeric strings up to the HNSW limit', () => {
    expect(parseEmbeddingDims(768)).toBe(768)
    expect(parseEmbeddingDims('1536')).toBe(1536)
    expect(parseEmbeddingDims(MAX_EMBEDDING_DIMS)).toBe(2000)
  })

  it.each([0, -1, 1.5, Number.NaN, '', 'abc', null, undefined])('rejects %s', (bad) => {
    expect(() => parseEmbeddingDims(bad)).toThrow(/positive integer/)
  })

  it('rejects more dimensions than pgvector can index, naming the limit', () => {
    expect(() => parseEmbeddingDims(2001)).toThrow(/2000/)
    expect(() => parseEmbeddingDims(3072)).toThrow(/HNSW/)
  })
})

describe('parseTriState', () => {
  it('maps spellings and defaults to auto', () => {
    expect(parseTriState(undefined, 'X')).toBe('auto')
    expect(parseTriState('', 'X')).toBe('auto')
    expect(parseTriState('AUTO', 'X')).toBe('auto')
    expect(parseTriState('true', 'X')).toBe('true')
    expect(parseTriState('1', 'X')).toBe('true')
    expect(parseTriState(false, 'X')).toBe('false')
    expect(parseTriState('off', 'X')).toBe('false')
  })

  it('names the variable on invalid input', () => {
    expect(() => parseTriState('maybe', 'NUXT_LITELLM_EMBEDDINGS_SEND_DIMENSIONS')).toThrow(/NUXT_LITELLM_EMBEDDINGS_SEND_DIMENSIONS/)
  })
})

describe('request parameter selection', () => {
  it('the default model (mistral-embed): nothing extra, its 1024-d output is fixed', () => {
    expect(DEFAULT_EMBEDDINGS_MODEL).toBe('mistral-embed')
    expect(DEFAULT_EMBEDDINGS_DIMS).toBe(1024)
    expect(embeddingRequestParams(resolveRequestShape(), 1024, 'RETRIEVAL_DOCUMENT')).toEqual({})
  })

  it('auto means off, for every model', () => {
    const shape = resolveRequestShape({ sendDimensions: 'auto', sendTaskHint: 'auto' })
    expect(shape).toEqual({ sendTaskHint: false, sendDimensions: false })
  })

  it('operator opt-in sends the task hint and the dimensions', () => {
    const optIn = resolveRequestShape({ sendDimensions: 'true', sendTaskHint: 'true' })
    expect(embeddingRequestParams(optIn, 1024, 'RETRIEVAL_QUERY')).toEqual({ task: 'retrieval.query', dimensions: 1024 })
    expect(embeddingRequestParams(optIn, 768, 'RETRIEVAL_DOCUMENT')).toEqual({ task: 'retrieval.passage', dimensions: 768 })
    expect(embeddingRequestParams(optIn, 768, 'CLUSTERING').task).toBe('text-matching')
    const optOut = resolveRequestShape({ sendDimensions: 'false', sendTaskHint: 'false' })
    expect(embeddingRequestParams(optOut, 768, 'RETRIEVAL_QUERY')).toEqual({})
  })
})
