import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { searchKnowledge } from '../../server/repos/knowledge'
import { createUser, createWorkspace } from '../integration/setup/fixtures'

// Hybrid-search fusion test. We stub embeddings directly at the SQL
// layer (so we're not coupled to the Gemini API) and check that:
//   - pure lexical matches surface via the BM25 path
//   - pure semantic matches surface via the vector path
//   - chunks matching both merge (not duplicate)
//   - RRF ordering prefers "in both" over "in one"
//
// Embeddings are manually crafted 768-dim vectors with unit norm so
// cosine similarity is predictable. We stick to cardinal-axis vectors
// (e[i] = 1, else 0) — pairs on the same axis have sim=1.0, on
// different axes sim=0.

const DIM = 768

function axisVec(i: number): number[] {
  const v = new Array(DIM).fill(0)
  v[i] = 1
  return v
}

// Drizzle's pg driver wants pgvector values as the `[1,2,3]` literal
// string format the pgvector extension parses.
function asVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`
}

async function seedChunk(args: {
  workspaceId: string
  knowledgeId: string
  chunkIndex: number
  content: string
  vector: number[]
}): Promise<void> {
  const db = testDb()
  await db.query(
    `INSERT INTO workspace_knowledge_chunks
     (knowledge_id, workspace_id, chunk_index, content, tokens, embedding)
     VALUES ($1, $2, $3, $4, $5, $6::vector)`,
    [
      args.knowledgeId,
      args.workspaceId,
      args.chunkIndex,
      args.content,
      Math.ceil(args.content.length / 4),
      asVectorLiteral(args.vector)
    ]
  )
}

async function seedKnowledgeRow(args: { workspaceId: string, knowledgeId: string, filename: string }): Promise<void> {
  const db = testDb()
  await db.query(
    `INSERT INTO workspace_knowledge
     (knowledge_id, workspace_id, filename, source_ext, mime_type, size_bytes, s3_key, status, embedding_version, chunk_count, token_count)
     VALUES ($1, $2, $3, 'pdf', 'application/pdf', 1, $4, 'ready', 'test:768', 0, 0)`,
    [
      args.knowledgeId,
      args.workspaceId,
      args.filename,
      `workspaces/${args.workspaceId}/knowledge/${args.knowledgeId}.pdf`
    ]
  )
}

describe('searchKnowledge (hybrid)', () => {
  beforeEach(async () => { await resetDb() })

  it('returns a pure-lexical match when no semantic match exists', async () => {
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    await seedKnowledgeRow({ workspaceId: ws.workspaceId, knowledgeId: 'kn-1', filename: 'manual.pdf' })
    await seedChunk({
      workspaceId: ws.workspaceId,
      knowledgeId: 'kn-1',
      chunkIndex: 1,
      content: 'The procurement policy covers vendor onboarding in section 4.3.',
      // axis 0 — totally unrelated to the query vector.
      vector: axisVec(0)
    })
    await seedChunk({
      workspaceId: ws.workspaceId,
      knowledgeId: 'kn-1',
      chunkIndex: 2,
      content: 'Employees should submit their travel expenses quarterly.',
      vector: axisVec(1)
    })

    // Query vector lives on axis 99 — no semantic overlap with either
    // chunk. The BM25 path has to do the work.
    const hits = await searchKnowledge({
      workspaceId: ws.workspaceId,
      queryText: 'procurement vendor onboarding',
      queryEmbedding: axisVec(99),
      topK: 3
    })

    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.chunkIndex).toBe(1)
    expect(hits[0]!.textScore).toBeGreaterThan(0)
  })

  it('returns a pure-semantic match when no lexical overlap exists', async () => {
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    await seedKnowledgeRow({ workspaceId: ws.workspaceId, knowledgeId: 'kn-1', filename: 'policy.pdf' })
    await seedChunk({
      workspaceId: ws.workspaceId,
      knowledgeId: 'kn-1',
      chunkIndex: 1,
      content: 'Supplier onboarding guidelines for new partners.',
      vector: axisVec(5)
    })
    await seedChunk({
      workspaceId: ws.workspaceId,
      knowledgeId: 'kn-1',
      chunkIndex: 2,
      content: 'Quarterly expense filings required for all staff.',
      vector: axisVec(6)
    })

    // Query on axis 5 — cosine sim = 1 with chunk 1, 0 with chunk 2.
    // Query text "xyzblargh" won't hit BM25 on either — forces the
    // vector path to drive ordering.
    const hits = await searchKnowledge({
      workspaceId: ws.workspaceId,
      queryText: 'xyzblargh',
      queryEmbedding: axisVec(5),
      topK: 3
    })

    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.chunkIndex).toBe(1)
    expect(hits[0]!.similarity).toBeGreaterThan(0.99)
  })

  it('merges chunks that match both sources (no duplicates)', async () => {
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    await seedKnowledgeRow({ workspaceId: ws.workspaceId, knowledgeId: 'kn-1', filename: 'both.pdf' })
    await seedChunk({
      workspaceId: ws.workspaceId,
      knowledgeId: 'kn-1',
      chunkIndex: 1,
      content: 'Gradient descent converges faster with momentum.',
      // On the query's semantic axis AND contains the query keywords.
      vector: axisVec(10)
    })

    const hits = await searchKnowledge({
      workspaceId: ws.workspaceId,
      queryText: 'gradient descent momentum',
      queryEmbedding: axisVec(10),
      topK: 5
    })

    // One row, not two — the key (knowledgeId + chunkIndex) de-duped
    // across sources. Both scores populated.
    const matching = hits.filter(h => h.chunkIndex === 1)
    expect(matching.length).toBe(1)
    expect(matching[0]!.similarity).toBeGreaterThan(0.99)
    expect(matching[0]!.textScore).toBeGreaterThan(0)
  })

  it('fuses ranking so a both-source hit beats a single-source hit', async () => {
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    await seedKnowledgeRow({ workspaceId: ws.workspaceId, knowledgeId: 'kn-1', filename: 'mix.pdf' })
    // Chunk A: semantic rank 1, BM25 rank 1 (appears in both lists).
    await seedChunk({
      workspaceId: ws.workspaceId,
      knowledgeId: 'kn-1',
      chunkIndex: 1,
      content: 'Transformers leverage attention for sequence modeling.',
      vector: axisVec(20)
    })
    // Chunk B: semantic rank 2 only (no keyword overlap, off-axis sim).
    await seedChunk({
      workspaceId: ws.workspaceId,
      knowledgeId: 'kn-1',
      chunkIndex: 2,
      content: 'Recurrent networks process data sequentially.',
      vector: axisVec(21)
    })

    const hits = await searchKnowledge({
      workspaceId: ws.workspaceId,
      queryText: 'transformers attention',
      queryEmbedding: axisVec(20),
      topK: 5
    })

    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]!.chunkIndex).toBe(1)
    // Chunk A's RRF is sum of two contributions vs B's one, so A's
    // score is strictly higher.
    if (hits.length >= 2) {
      expect(hits[0]!.rrfScore).toBeGreaterThan(hits[1]!.rrfScore)
    }
  })

  it('scopes results to the caller\'s workspace', async () => {
    const u = await createUser()
    const wsA = await createWorkspace(u.id)
    const wsB = await createWorkspace(u.id, { workspaceId: 'ws-other' })
    await seedKnowledgeRow({ workspaceId: wsB.workspaceId, knowledgeId: 'kn-leak', filename: 'leak.pdf' })
    await seedChunk({
      workspaceId: wsB.workspaceId,
      knowledgeId: 'kn-leak',
      chunkIndex: 1,
      content: 'This content belongs to another workspace entirely.',
      vector: axisVec(30)
    })

    const hits = await searchKnowledge({
      workspaceId: wsA.workspaceId,
      queryText: 'another workspace entirely',
      queryEmbedding: axisVec(30),
      topK: 5
    })

    expect(hits).toEqual([])
  })
})
