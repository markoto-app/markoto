import { describe, it, expect, beforeEach, vi } from 'vitest'
import { stubEnv } from '../../helpers/env'

// The runtime gate for knowledge features: ok / dimension_mismatch /
// invalid_config / check_failed, cached briefly, and recovering on its own.

const state = vi.hoisted(() => ({
  columnType: 'vector(768)' as string | null,
  stored: 0,
  queries: 0,
  failQuery: false
}))

// The configured dimension comes from the typed env (shared/env).
function stubDims(dims: number): void {
  stubEnv({ NUXT_LITELLM_EMBEDDINGS_DIMS: String(dims) })
}

vi.mock('../../../server/db/client', () => ({
  useDatabasePool: () => ({
    query: async (sql: string) => {
      state.queries++
      if (state.failQuery) throw new Error('connection refused')
      if (sql.includes('format_type')) return { rows: [{ type: state.columnType }] }
      return { rows: [{ n: state.stored }] }
    }
  })
}))

const { getKnowledgeEmbeddingsStatus, assertKnowledgeEmbeddingsReady, resetKnowledgeEmbeddingsStatus }
  = await import('../../../server/utils/knowledge/knowledgeEmbeddingsStatus')

beforeEach(() => {
  stubDims(768)
  state.columnType = 'vector(768)'
  state.stored = 0
  state.queries = 0
  state.failQuery = false
  resetKnowledgeEmbeddingsStatus()
})

describe('getKnowledgeEmbeddingsStatus', () => {
  it('ok when the column matches the configured dimension', async () => {
    expect(await getKnowledgeEmbeddingsStatus()).toEqual({ ok: true })
    await expect(assertKnowledgeEmbeddingsReady()).resolves.toBeUndefined()
  })

  it('dimension_mismatch names both sizes, the stored vectors and the re-embed command', async () => {
    stubDims(1536)
    state.stored = 42
    const s = await getKnowledgeEmbeddingsStatus()
    expect(s.ok).toBe(false)
    if (s.ok) throw new Error('unreachable')
    expect(s.code).toBe('dimension_mismatch')
    expect(s.message).toContain('768-dimensional')
    expect(s.message).toContain('NUXT_LITELLM_EMBEDDINGS_DIMS=1536')
    expect(s.message).toContain('42 stored vectors')
    expect(s.message).toContain('bun run knowledge:reembed')
    await expect(assertKnowledgeEmbeddingsReady()).rejects.toThrow(/knowledge:reembed/)
  })

  it('invalid_config for a dimension beyond the HNSW limit, without touching the database', async () => {
    stubDims(3072)
    const s = await getKnowledgeEmbeddingsStatus()
    expect(s).toMatchObject({ ok: false, code: 'invalid_config' })
    expect(state.queries).toBe(0)
  })

  it('check_failed when the catalog cannot be read', async () => {
    state.failQuery = true
    expect(await getKnowledgeEmbeddingsStatus()).toMatchObject({ ok: false, code: 'check_failed' })
  })

  it('caches the answer, and recovers after a reset (e.g. boot reconciliation)', async () => {
    stubDims(16)
    expect((await getKnowledgeEmbeddingsStatus()).ok).toBe(false)
    const after = state.queries
    await getKnowledgeEmbeddingsStatus()
    expect(state.queries).toBe(after) // served from cache
    state.columnType = 'vector(16)' // the re-embed command retyped the column
    resetKnowledgeEmbeddingsStatus()
    expect(await getKnowledgeEmbeddingsStatus()).toEqual({ ok: true })
  })
})
