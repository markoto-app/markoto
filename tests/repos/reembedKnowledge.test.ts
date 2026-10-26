import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser, createWorkspace } from '../integration/setup/fixtures'
import { readEmbeddingColumnDims, withEmbeddingDimensionLock } from '../../server/utils/embeddingColumn'
import { runReembed, PENDING_VERSION } from '../../server/utils/reembedKnowledge'

// The re-embed driver against a real pgvector and a fake embedder.

const OLD_TAG = 'jina/jina-embeddings-v5-text-nano:768'
const NEW_TAG = 'custom/test-model:16'

function vec768(): string {
  return `[${new Array(768).fill(0.1).join(',')}]`
}

async function seedFile(workspaceId: string, knowledgeId: string, contents: string[]): Promise<void> {
  const db = testDb()
  await db.query(
    `INSERT INTO workspace_knowledge
     (knowledge_id, workspace_id, filename, source_ext, mime_type, size_bytes, s3_key, status, embedding_version, chunk_count, token_count)
     VALUES ($1, $2, $3, 'md', 'text/markdown', 1, $4, 'ready', $5, $6, 0)`,
    [knowledgeId, workspaceId, `${knowledgeId}.md`, `workspaces/${workspaceId}/knowledge/${knowledgeId}.md`, OLD_TAG, contents.length]
  )
  for (const [i, content] of contents.entries()) {
    await db.query(
      `INSERT INTO workspace_knowledge_chunks (knowledge_id, workspace_id, chunk_index, content, tokens, embedding)
       VALUES ($1, $2, $3, $4, 1, $5::vector)`,
      [knowledgeId, workspaceId, i, content, vec768()]
    )
  }
}

// Fake embedder: a deterministic vector derived from the text length.
function fakeEmbedder(dims: number, calls: string[][]) {
  return async (texts: string[]): Promise<number[][]> => {
    calls.push(texts)
    return texts.map(t => new Array(dims).fill(t.length))
  }
}

async function restoreDefaultColumn(): Promise<void> {
  const db = testDb()
  await db.query('DROP INDEX IF EXISTS idx_wkc_embedding')
  await db.query('TRUNCATE workspace_knowledge_chunks')
  await db.query('ALTER TABLE workspace_knowledge_chunks ALTER COLUMN embedding TYPE vector(768) USING NULL')
  await db.query('CREATE INDEX idx_wkc_embedding ON workspace_knowledge_chunks USING hnsw (embedding vector_cosine_ops)')
}

let wsId: string

beforeEach(async () => {
  await resetDb()
  await restoreDefaultColumn()
  const u = await createUser()
  wsId = (await createWorkspace(u.id)).workspaceId
})

afterEach(async () => {
  await resetDb()
  await restoreDefaultColumn()
})

async function versions(): Promise<Record<string, string>> {
  const res = await testDb().query<{ knowledge_id: string, embedding_version: string }>(
    'SELECT knowledge_id, embedding_version FROM workspace_knowledge'
  )
  return Object.fromEntries(res.rows.map(r => [r.knowledge_id, r.embedding_version]))
}

async function indexExists(): Promise<boolean> {
  const res = await testDb().query('SELECT 1 FROM pg_indexes WHERE indexname = $1', ['idx_wkc_embedding'])
  return res.rowCount === 1
}

describe('runReembed', () => {
  it('retypes the column, re-embeds every chunk, tags files and rebuilds the index', async () => {
    await seedFile(wsId, 'k1', ['alpha', 'bravo charlie'])
    await seedFile(wsId, 'k2', ['delta'])
    const calls: string[][] = []

    const summary = await runReembed({
      pool: testDb(), dims: 16, versionTag: NEW_TAG, embed: fakeEmbedder(16, calls), batchSize: 1
    })

    expect(summary).toMatchObject({ dryRun: false, retyped: true, filesTotal: 2, filesDone: 2, chunksDone: 3 })
    expect(await readEmbeddingColumnDims(testDb())).toBe(16)
    expect(await versions()).toEqual({ k1: NEW_TAG, k2: NEW_TAG })
    expect(await indexExists()).toBe(true)
    expect(calls.every(c => c.length === 1)).toBe(true) // batchSize honoured
    const res = await testDb().query<{ content: string, n: number }>(
      'SELECT content, vector_dims(embedding) AS n FROM workspace_knowledge_chunks ORDER BY id'
    )
    expect(res.rows.map(r => r.n)).toEqual([16, 16, 16])
  })

  it('same-size model switch keeps the column and replaces the vectors', async () => {
    await seedFile(wsId, 'k1', ['alpha'])
    const calls: string[][] = []
    const summary = await runReembed({
      pool: testDb(), dims: 768, versionTag: 'custom/other:768', embed: fakeEmbedder(768, calls), batchSize: 10
    })
    expect(summary).toMatchObject({ retyped: false, filesDone: 1 })
    expect(await readEmbeddingColumnDims(testDb())).toBe(768)
    const res = await testDb().query<{ first: number }>('SELECT (embedding::real[])[1] AS first FROM workspace_knowledge_chunks')
    expect(res.rows[0]!.first).toBe(5) // 'alpha'.length from the fake, not the old 0.1
  })

  it('is resumable: a failure keeps finished files, a rerun only does the rest', async () => {
    await seedFile(wsId, 'k1', ['one'])
    await seedFile(wsId, 'k2', ['two'])
    await seedFile(wsId, 'k3', ['three'])
    let n = 0
    const flaky = async (texts: string[]): Promise<number[][]> => {
      if (++n === 2) throw new Error('provider 429')
      return texts.map(() => new Array(16).fill(1))
    }
    await expect(runReembed({ pool: testDb(), dims: 16, versionTag: NEW_TAG, embed: flaky, batchSize: 10 }))
      .rejects.toThrow('provider 429')
    // k1 done, k2 + k3 still pending; column already retyped, index not rebuilt yet.
    expect(await versions()).toEqual({ k1: NEW_TAG, k2: PENDING_VERSION, k3: PENDING_VERSION })
    expect(await indexExists()).toBe(false)

    const calls: string[][] = []
    const summary = await runReembed({ pool: testDb(), dims: 16, versionTag: NEW_TAG, embed: fakeEmbedder(16, calls), batchSize: 10 })
    expect(summary).toMatchObject({ retyped: false, filesTotal: 2, filesDone: 2 })
    expect(calls.flat().sort()).toEqual(['three', 'two'])
    expect(await versions()).toEqual({ k1: NEW_TAG, k2: NEW_TAG, k3: NEW_TAG })
    expect(await indexExists()).toBe(true)
  })

  it('does nothing when everything is already on the target tag', async () => {
    await seedFile(wsId, 'k1', ['alpha'])
    await testDb().query('UPDATE workspace_knowledge SET embedding_version = $1', [OLD_TAG])
    const calls: string[][] = []
    const summary = await runReembed({ pool: testDb(), dims: 768, versionTag: OLD_TAG, embed: fakeEmbedder(768, calls), batchSize: 10 })
    expect(summary).toMatchObject({ filesTotal: 0, filesDone: 0, retyped: false })
    expect(calls).toHaveLength(0)
  })

  it('force re-embeds files already carrying the target tag', async () => {
    await seedFile(wsId, 'k1', ['alpha'])
    await testDb().query('UPDATE workspace_knowledge SET embedding_version = $1', [OLD_TAG])
    const calls: string[][] = []
    const summary = await runReembed({
      pool: testDb(), dims: 768, versionTag: OLD_TAG, embed: fakeEmbedder(768, calls), batchSize: 10, force: true
    })
    expect(summary).toMatchObject({ retyped: false, filesTotal: 1, filesDone: 1 })
    expect(calls.flat()).toEqual(['alpha'])
  })

  it('dry run reports and changes nothing', async () => {
    await seedFile(wsId, 'k1', ['alpha'])
    const calls: string[][] = []
    const lines: string[] = []
    const summary = await runReembed({
      pool: testDb(), dims: 16, versionTag: NEW_TAG, embed: fakeEmbedder(16, calls), batchSize: 10, dryRun: true, log: l => lines.push(l)
    })
    expect(summary).toMatchObject({ dryRun: true, filesTotal: 1, filesDone: 0 })
    expect(calls).toHaveLength(0)
    expect(await readEmbeddingColumnDims(testDb())).toBe(768)
    expect(await versions()).toEqual({ k1: OLD_TAG })
    expect(lines.join('\n')).toContain('will be retyped')
  })

  it('rejects a wrong-sized vector from the embedder without writing it', async () => {
    await seedFile(wsId, 'k1', ['alpha'])
    await expect(runReembed({
      pool: testDb(), dims: 16, versionTag: NEW_TAG, embed: async t => t.map(() => new Array(8).fill(1)), batchSize: 10
    })).rejects.toThrow(/8-dim vector, expected 16/)
    expect(await versions()).toEqual({ k1: PENDING_VERSION })
  })

  it('refuses to run while another process holds the dimension lock', async () => {
    await seedFile(wsId, 'k1', ['alpha'])
    const held = await withEmbeddingDimensionLock(testDb(), { waitMs: 0 }, async () => {
      await expect(runReembed({ pool: testDb(), dims: 16, versionTag: NEW_TAG, embed: fakeEmbedder(16, []), batchSize: 10 }))
        .rejects.toThrow(/holds the embedding-dimension lock/)
      return true
    })
    expect(held).toEqual({ acquired: true, value: true })
    expect(await readEmbeddingColumnDims(testDb())).toBe(768)
  })
})
