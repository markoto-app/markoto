import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { searchKnowledge } from '../../server/repos/knowledge'
import { createUser, createWorkspace } from '../integration/setup/fixtures'

// Hybrid-search fusion test. We stub embeddings directly at the SQL
// layer (so we're not coupled to the embeddings provider) and check that:
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
  beforeEach(async () => {
    await resetDb()
  })

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
    expect(hits.length < 2 || hits[0]!.rrfScore > hits[1]!.rrfScore).toBe(true)
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

// Adversarial tests
//
// Hypotheses that interrogate failure modes the happy-path suite above doesn't touch. Each test states a
// hypothesis and pins the actual behaviour. Where current behaviour is suboptimal but not a security/correctness
// bug, the test documents it for future review (with a comment explaining the cost-benefit).

describe('searchKnowledge — adversarial: query degenerate cases', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('all-stopwords queryText (BM25 returns empty tsquery) — vector still works', async () => {
    // `websearch_to_tsquery('english', 'the and of')` → empty tsquery →
    // `content_tsv @@ ''` returns false → zero BM25 rows. The vector
    // path still hits, so search degrades gracefully to vector-only.
    // If a refactor added a "must have BM25 hits" guard, this test
    // would catch the regression.
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    await seedKnowledgeRow({ workspaceId: ws.workspaceId, knowledgeId: 'kn-1', filename: 'doc.pdf' })
    await seedChunk({
      workspaceId: ws.workspaceId,
      knowledgeId: 'kn-1',
      chunkIndex: 0,
      content: 'cross-entropy loss derivation',
      vector: axisVec(7)
    })

    const hits = await searchKnowledge({
      workspaceId: ws.workspaceId,
      queryText: 'the and of', // all stopwords
      queryEmbedding: axisVec(7),
      topK: 5
    })

    expect(hits).toHaveLength(1)
    expect(hits[0]!.similarity).toBe(1)
    expect(hits[0]!.textScore).toBe(0) // BM25 contributed nothing
  })

  it('empty queryText is also handled gracefully (vector-only path)', async () => {
    // Edge of the edge: empty string. `websearch_to_tsquery('')` →
    // empty tsquery, same as stopwords. Pin that the SUT doesn't
    // crash + still returns vector hits.
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    await seedKnowledgeRow({ workspaceId: ws.workspaceId, knowledgeId: 'kn-1', filename: 'doc.pdf' })
    await seedChunk({
      workspaceId: ws.workspaceId,
      knowledgeId: 'kn-1',
      chunkIndex: 0,
      content: 'whatever',
      vector: axisVec(7)
    })

    const hits = await searchKnowledge({
      workspaceId: ws.workspaceId,
      queryText: '',
      queryEmbedding: axisVec(7),
      topK: 5
    })

    expect(hits).toHaveLength(1)
    expect(hits[0]!.textScore).toBe(0)
  })
})

describe('searchKnowledge — adversarial: topK edges', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('topK = 0 returns an empty array (no SQL error)', async () => {
    // `Math.max(0, 0*4) = 0` → `LIMIT 0` on both queries. Postgres
    // accepts LIMIT 0 (returns no rows). If a refactor used 1-based
    // arithmetic somewhere this could become LIMIT -1 which DOES error.
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    await seedKnowledgeRow({ workspaceId: ws.workspaceId, knowledgeId: 'kn-1', filename: 'doc.pdf' })
    await seedChunk({
      workspaceId: ws.workspaceId, knowledgeId: 'kn-1',
      chunkIndex: 0, content: 'something', vector: axisVec(1)
    })

    const hits = await searchKnowledge({
      workspaceId: ws.workspaceId,
      queryText: 'something',
      queryEmbedding: axisVec(1),
      topK: 0
    })

    expect(hits).toEqual([])
  })

  it('topK far larger than available chunks returns what exists (no padding, no crash)', async () => {
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    await seedKnowledgeRow({ workspaceId: ws.workspaceId, knowledgeId: 'kn-1', filename: 'doc.pdf' })
    await seedChunk({
      workspaceId: ws.workspaceId, knowledgeId: 'kn-1',
      chunkIndex: 0, content: 'unique-keyword-xyz', vector: axisVec(1)
    })

    const hits = await searchKnowledge({
      workspaceId: ws.workspaceId,
      queryText: 'unique-keyword-xyz',
      queryEmbedding: axisVec(1),
      topK: 100
    })

    expect(hits).toHaveLength(1)
  })
})

describe('searchKnowledge — adversarial: similarity sign + threshold', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('FINDING: anti-parallel vectors (similarity = -1) ARE returned with default threshold=0', async () => {
    // The SQL guard is `threshold > 0 ? '${similarity} > ${threshold}' : true`.
    // With the default threshold = 0, the filter degenerates to `true`,
    // meaning chunks anti-parallel to the query (similarity = -1) get
    // included in the candidate pool and contribute a positive RRF
    // score from the bottom of the vector pool.
    //
    // Real-world impact: low. Real text embeddings rarely align anti-
    // parallel. But it IS a documented behaviour: callers wanting
    // semantic-only results should pass `similarityThreshold > 0`.
    //
    // If this changes (e.g. to `>= 0` as the default), this test breaks
    // — and that's the right place to decide whether the change is
    // wanted.
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    await seedKnowledgeRow({ workspaceId: ws.workspaceId, knowledgeId: 'kn-1', filename: 'doc.pdf' })
    await seedChunk({
      workspaceId: ws.workspaceId, knowledgeId: 'kn-1',
      chunkIndex: 0, content: 'no lexical match here',
      vector: axisVec(7).map(x => -x) // anti-parallel to query
    })

    const hits = await searchKnowledge({
      workspaceId: ws.workspaceId,
      queryText: 'completely unrelated query', // no BM25 hit
      queryEmbedding: axisVec(7),
      topK: 5
    })

    expect(hits).toHaveLength(1)
    expect(hits[0]!.similarity).toBe(-1)
  })

  it('similarityThreshold > 0 filters anti-parallel and orthogonal hits', async () => {
    // Symmetric pin: if the caller DOES set a threshold, the filter
    // applies. orthogonal (sim = 0) AND anti-parallel (sim = -1) both
    // get cut, so only the matching chunk survives.
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    await seedKnowledgeRow({ workspaceId: ws.workspaceId, knowledgeId: 'kn-1', filename: 'doc.pdf' })
    await seedChunk({
      workspaceId: ws.workspaceId, knowledgeId: 'kn-1',
      chunkIndex: 0, content: 'matching chunk', vector: axisVec(7)
    })
    await seedChunk({
      workspaceId: ws.workspaceId, knowledgeId: 'kn-1',
      chunkIndex: 1, content: 'orthogonal chunk', vector: axisVec(8)
    })
    await seedChunk({
      workspaceId: ws.workspaceId, knowledgeId: 'kn-1',
      chunkIndex: 2, content: 'anti-parallel chunk',
      vector: axisVec(7).map(x => -x)
    })

    const hits = await searchKnowledge({
      workspaceId: ws.workspaceId,
      queryText: 'no overlap text',
      queryEmbedding: axisVec(7),
      topK: 5,
      similarityThreshold: 0.5
    })

    expect(hits).toHaveLength(1)
    expect(hits[0]!.chunkIndex).toBe(0)
    expect(hits[0]!.similarity).toBe(1)
  })
})

describe('searchKnowledge — zero-vector NaN guard', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('a zero-vector chunk does NOT pollute results (NaN filtered out)', async () => {
    // Empirical finding: in Postgres, `NaN > 0.5` returns TRUE and
    // `ORDER BY value DESC` puts NaN at the TOP. Without an explicit
    // NaN guard, a single zero-embedding chunk (corruption, manual
    // seed, future ingest bug) would dominate every workspace search.
    //
    // The fix (server/repos/knowledge.ts) adds `${similarity} !=
    // 'NaN'::float8` to the vector pass's WHERE clause. NaN-similarity
    // chunks are excluded from the candidate pool entirely.
    //
    // This test seeds a zero vector + a legitimate match, queries
    // something neither matches lexically, and verifies the legitimate
    // match wins (NOT the zero vector).
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    await seedKnowledgeRow({ workspaceId: ws.workspaceId, knowledgeId: 'kn-good', filename: 'good.pdf' })
    await seedKnowledgeRow({ workspaceId: ws.workspaceId, knowledgeId: 'kn-zero', filename: 'corrupt.pdf' })
    await seedChunk({
      workspaceId: ws.workspaceId, knowledgeId: 'kn-good',
      chunkIndex: 0, content: 'legitimate match for query',
      vector: axisVec(7)
    })
    await seedChunk({
      workspaceId: ws.workspaceId, knowledgeId: 'kn-zero',
      chunkIndex: 0, content: 'corrupt zero vector',
      vector: new Array(DIM).fill(0)
    })

    const hits = await searchKnowledge({
      workspaceId: ws.workspaceId,
      queryText: 'something other than the chunk content',
      queryEmbedding: axisVec(7),
      topK: 5
    })

    // Only the legitimate chunk shows up; the corrupt zero-vector
    // chunk is filtered at the SQL layer.
    expect(hits).toHaveLength(1)
    expect(hits[0]!.knowledgeId).toBe('kn-good')
    expect(hits[0]!.similarity).toBe(1)
  })

  it('NaN guard does not regress the threshold>0 path', async () => {
    // The NaN filter is composed with the threshold filter via AND in
    // the threshold>0 branch. Make sure both are applied: a NaN row
    // must be excluded AND a too-low-similarity row must also be
    // excluded.
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    await seedKnowledgeRow({ workspaceId: ws.workspaceId, knowledgeId: 'kn-good', filename: 'good.pdf' })
    await seedKnowledgeRow({ workspaceId: ws.workspaceId, knowledgeId: 'kn-zero', filename: 'zero.pdf' })
    await seedKnowledgeRow({ workspaceId: ws.workspaceId, knowledgeId: 'kn-orth', filename: 'orth.pdf' })
    await seedChunk({ workspaceId: ws.workspaceId, knowledgeId: 'kn-good', chunkIndex: 0, content: 'good', vector: axisVec(7) })
    await seedChunk({ workspaceId: ws.workspaceId, knowledgeId: 'kn-zero', chunkIndex: 0, content: 'zero', vector: new Array(DIM).fill(0) })
    await seedChunk({ workspaceId: ws.workspaceId, knowledgeId: 'kn-orth', chunkIndex: 0, content: 'orth', vector: axisVec(99) })

    const hits = await searchKnowledge({
      workspaceId: ws.workspaceId,
      queryText: 'no overlap',
      queryEmbedding: axisVec(7),
      topK: 5,
      similarityThreshold: 0.5
    })

    expect(hits).toHaveLength(1)
    expect(hits[0]!.knowledgeId).toBe('kn-good')
  })
})

describe('searchKnowledge — schema invariant: knowledgeId is globally unique', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('PINNED INVARIANT: knowledge_id_unique constraint blocks cross-workspace id collision', async () => {
    // Hypothesis-falsifying probe: I'd assumed knowledgeIds could
    // collide across workspaces (nanoid(12) → ~1-in-200B per pair).
    // The schema actually has a UNIQUE constraint on knowledge_id
    // (workspace_knowledge_knowledge_id_unique), making my "merge map
    // cross-pollutes via shared key" scenario architecturally
    // impossible.
    //
    // This test PINS that invariant: the SUT's `keyOf(r) =
    // ${knowledgeId}#${chunkIndex}` merge logic is only safe BECAUSE
    // knowledgeId is globally unique. A future migration that loosened
    // the constraint to (workspaceId, knowledgeId) would silently make
    // cross-workspace merges possible — and this test would break,
    // signaling the merge key needs to be revisited.
    const u = await createUser()
    const wsA = await createWorkspace(u.id)
    const wsB = await createWorkspace(u.id, { workspaceId: 'ws-collide' })
    await seedKnowledgeRow({ workspaceId: wsA.workspaceId, knowledgeId: 'shared-k', filename: 'A.pdf' })

    await expect(
      seedKnowledgeRow({ workspaceId: wsB.workspaceId, knowledgeId: 'shared-k', filename: 'B.pdf' })
    ).rejects.toThrow(/unique/i)
  })
})
