import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { testDb } from '../integration/setup/db'
import {
  EMBEDDING_DIMENSION_LOCK,
  reconcileEmbeddingColumn,
  readEmbeddingColumnDims,
  withEmbeddingDimensionLock,
  type EmbeddingColumnTarget
} from '../../server/db/embeddingColumn'

// Boot-time dimension reconciliation against a real pgvector. A scratch table
// (same column/index shape as workspace_knowledge_chunks) keeps these tests
// from touching the real knowledge table other repos tests rely on.

const T: EmbeddingColumnTarget = { table: 'wkc_dim_test', column: 'embedding', index: 'idx_wkc_dim_test' }

async function createScratch(dims: number): Promise<void> {
  const db = testDb()
  await db.query(`DROP TABLE IF EXISTS ${T.table}`)
  await db.query(`CREATE TABLE ${T.table} (id serial PRIMARY KEY, embedding vector(${dims}))`)
  await db.query(`CREATE INDEX ${T.index} ON ${T.table} USING hnsw (embedding vector_cosine_ops)`)
}

function vec(dims: number): string {
  return `[${new Array(dims).fill(0.5).join(',')}]`
}

async function indexMethod(): Promise<string | undefined> {
  const res = await testDb().query<{ def: string }>(
    'SELECT indexdef AS def FROM pg_indexes WHERE tablename = $1 AND indexname = $2',
    [T.table, T.index]
  )
  const def = res.rows[0]?.def
  return def ? (/USING (\w+)/.exec(def)?.[1]) : undefined
}

beforeEach(async () => {
  await createScratch(8)
})

afterAll(async () => {
  await testDb().query(`DROP TABLE IF EXISTS ${T.table}`)
})

describe('readEmbeddingColumnDims', () => {
  it('reads the typmod of a sized vector column', async () => {
    expect(await readEmbeddingColumnDims(testDb(), T)).toBe(8)
  })

  it('reads the real knowledge column as the 768 default', async () => {
    expect(await readEmbeddingColumnDims(testDb())).toBe(768)
  })

  it('throws for a missing column', async () => {
    await expect(readEmbeddingColumnDims(testDb(), { ...T, column: 'nope' })).rejects.toThrow(/not found/)
  })
})

describe('reconcileEmbeddingColumn', () => {
  it('is a no-op when the column already matches', async () => {
    await testDb().query(`INSERT INTO ${T.table} (embedding) VALUES ($1::vector)`, [vec(8)])
    const r = await reconcileEmbeddingColumn(testDb(), 8, { target: T })
    expect(r).toEqual({ action: 'noop', currentDims: 8 })
    const rows = await testDb().query(`SELECT count(*)::int AS n FROM ${T.table}`)
    expect(rows.rows[0].n).toBe(1)
  })

  it('retypes an empty table and recreates the HNSW index', async () => {
    const r = await reconcileEmbeddingColumn(testDb(), 16, { target: T })
    expect(r).toEqual({ action: 'altered', previousDims: 8, currentDims: 16 })
    expect(await readEmbeddingColumnDims(testDb(), T)).toBe(16)
    expect(await indexMethod()).toBe('hnsw')
    // The new column accepts 16-d vectors and uses the index operator class.
    await testDb().query(`INSERT INTO ${T.table} (embedding) VALUES ($1::vector)`, [vec(16)])
  })

  it('retypes when rows exist but none holds a vector (nothing to lose)', async () => {
    await testDb().query(`INSERT INTO ${T.table} (embedding) VALUES (NULL), (NULL)`)
    const r = await reconcileEmbeddingColumn(testDb(), 4, { target: T })
    expect(r.action).toBe('altered')
    const rows = await testDb().query(`SELECT count(*)::int AS n FROM ${T.table}`)
    expect(rows.rows[0].n).toBe(2)
  })

  it('refuses to touch a table that holds vectors of another size', async () => {
    await testDb().query(`INSERT INTO ${T.table} (embedding) VALUES ($1::vector)`, [vec(8)])
    const r = await reconcileEmbeddingColumn(testDb(), 16, { target: T })
    expect(r.action).toBe('refused')
    if (r.action !== 'refused') throw new Error('unreachable')
    expect(r.storedVectors).toBe(1)
    expect(r.currentDims).toBe(8)
    expect(r.message).toContain('knowledge:reembed')
    expect(r.message).toContain('NUXT_LITELLM_EMBEDDINGS_DIMS=16')
    // Nothing changed: type, data and index intact.
    expect(await readEmbeddingColumnDims(testDb(), T)).toBe(8)
    expect(await indexMethod()).toBe('hnsw')
    const rows = await testDb().query(`SELECT count(*)::int AS n FROM ${T.table} WHERE embedding IS NOT NULL`)
    expect(rows.rows[0].n).toBe(1)
  })

  it('reports busy (and changes nothing) while another session holds the lock', async () => {
    const holder = await testDb().connect()
    try {
      await holder.query('SELECT pg_advisory_lock(hashtext($1))', [EMBEDDING_DIMENSION_LOCK])
      const r = await reconcileEmbeddingColumn(testDb(), 16, { target: T, lockWaitMs: 300 })
      expect(r.action).toBe('busy')
      expect(await readEmbeddingColumnDims(testDb(), T)).toBe(8)
    } finally {
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [EMBEDDING_DIMENSION_LOCK])
      holder.release()
    }
    const after = await reconcileEmbeddingColumn(testDb(), 16, { target: T })
    expect(after.action).toBe('altered')
  })

  it('waits for the lock and then finds the work already done', async () => {
    const holder = await testDb().connect()
    await holder.query('SELECT pg_advisory_lock(hashtext($1))', [EMBEDDING_DIMENSION_LOCK])
    const pending = reconcileEmbeddingColumn(testDb(), 16, { target: T, lockWaitMs: 5000 })
    await new Promise(resolve => setTimeout(resolve, 400))
    // The lock holder (e.g. the re-embed script) finishes the job itself.
    await holder.query(`ALTER TABLE ${T.table} ALTER COLUMN embedding TYPE vector(16) USING NULL`)
    await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [EMBEDDING_DIMENSION_LOCK])
    holder.release()
    expect(await pending).toEqual({ action: 'noop', currentDims: 16 })
  })

  it('serialises two instances booting at once: one alters, the other no-ops', async () => {
    const results = await Promise.all([
      reconcileEmbeddingColumn(testDb(), 24, { target: T }),
      reconcileEmbeddingColumn(testDb(), 24, { target: T })
    ])
    expect(results.map(r => r.action).sort()).toEqual(['altered', 'noop'])
    expect(await readEmbeddingColumnDims(testDb(), T)).toBe(24)
  })

  it('rejects identifiers that are not plain snake_case names', async () => {
    await expect(reconcileEmbeddingColumn(testDb(), 16, { target: { ...T, table: 'x; DROP TABLE y' } })).rejects.toThrow()
  })
})

describe('withEmbeddingDimensionLock', () => {
  it('is exclusive and released afterwards', async () => {
    const outcome = await withEmbeddingDimensionLock(testDb(), { waitMs: 0 }, async () => {
      const inner = await withEmbeddingDimensionLock(testDb(), { waitMs: 0 }, async () => 'nested')
      return inner.acquired
    })
    expect(outcome).toEqual({ acquired: true, value: false })
    const again = await withEmbeddingDimensionLock(testDb(), { waitMs: 0 }, async () => 'ok')
    expect(again).toEqual({ acquired: true, value: 'ok' })
  })
})
