import { describe, it, expect } from 'vitest'
import {
  MAX_EMBEDDING_DIMS,
  embeddingRequestParams,
  isJinaModel,
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
  it('detects Jina models case-insensitively', () => {
    expect(isJinaModel('jina-embeddings-v5-text-nano')).toBe(true)
    expect(isJinaModel('Jina-Embeddings-v3')).toBe(true)
    expect(isJinaModel('custom-embeddings')).toBe(false)
    expect(isJinaModel('text-embedding-3-small')).toBe(false)
  })

  it('Jina default: task hint + dimensions (unchanged behaviour)', () => {
    const shape = resolveRequestShape('jina-embeddings-v5-text-nano')
    expect(embeddingRequestParams(shape, 768, 'RETRIEVAL_DOCUMENT')).toEqual({ task: 'retrieval.passage', dimensions: 768 })
    expect(embeddingRequestParams(shape, 768, 'RETRIEVAL_QUERY')).toEqual({ task: 'retrieval.query', dimensions: 768 })
    expect(embeddingRequestParams(shape, 768, 'CLUSTERING').task).toBe('text-matching')
  })

  it('other models: nothing extra by default', () => {
    const shape = resolveRequestShape('custom-embeddings')
    expect(embeddingRequestParams(shape, 1536, 'RETRIEVAL_DOCUMENT')).toEqual({})
  })

  it('operator overrides win in both directions', () => {
    const optIn = resolveRequestShape('custom-embeddings', { sendDimensions: 'true', sendTaskHint: 'true' })
    expect(embeddingRequestParams(optIn, 1024, 'RETRIEVAL_QUERY')).toEqual({ task: 'retrieval.query', dimensions: 1024 })
    const optOut = resolveRequestShape('jina-embeddings-v5-text-nano', { sendDimensions: 'false', sendTaskHint: 'false' })
    expect(embeddingRequestParams(optOut, 768, 'RETRIEVAL_QUERY')).toEqual({})
  })
})
