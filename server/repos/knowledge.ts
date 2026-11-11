import { and, desc, eq, sql, cosineDistance } from 'drizzle-orm'
import { workspaceKnowledge, workspaceKnowledgeChunks } from '../db/schema'
import { useDatabase } from '../utils/platform/database'
import { pooledWorkspaceIdsSubquery } from './workspaceSubscriptions'

/**
 * Data access for the workspace knowledge base. Kept thin — business rules
 * (cap enforcement, processing triggers, access control) live in the
 * callers. Vector search is here because it's a single query.
 */

export interface KnowledgeRow {
  knowledgeId: string
  workspaceId: string
  filename: string
  sourceExt: string
  mimeType: string
  sizeBytes: number
  s3Key: string
  status: 'processing' | 'ready' | 'failed'
  errorMessage: string | null
  chunkCount: number
  tokenCount: number
  embeddingVersion: string
  uploaderId: number | null
  createdAt: Date
  processedAt: Date | null
}

// Public shape — `markdownCache` is intentionally omitted from list
// responses (cache can be large, and the UI doesn't need it).
const LIST_COLUMNS = {
  knowledgeId: workspaceKnowledge.knowledgeId,
  workspaceId: workspaceKnowledge.workspaceId,
  filename: workspaceKnowledge.filename,
  sourceExt: workspaceKnowledge.sourceExt,
  mimeType: workspaceKnowledge.mimeType,
  sizeBytes: workspaceKnowledge.sizeBytes,
  s3Key: workspaceKnowledge.s3Key,
  status: workspaceKnowledge.status,
  errorMessage: workspaceKnowledge.errorMessage,
  chunkCount: workspaceKnowledge.chunkCount,
  tokenCount: workspaceKnowledge.tokenCount,
  embeddingVersion: workspaceKnowledge.embeddingVersion,
  uploaderId: workspaceKnowledge.uploaderId,
  createdAt: workspaceKnowledge.createdAt,
  processedAt: workspaceKnowledge.processedAt
} as const

export async function listKnowledge(workspaceId: string): Promise<KnowledgeRow[]> {
  const db = useDatabase()
  return db.select(LIST_COLUMNS).from(workspaceKnowledge)
    .where(eq(workspaceKnowledge.workspaceId, workspaceId))
    .orderBy(desc(workspaceKnowledge.createdAt))
}

/** Minimal shape used to bake filenames into the AI's system prompt. */
export interface KnowledgeBrief {
  knowledgeId: string
  filename: string
  sizeBytes: number
  sourceExt: string
  tokenCount: number
  /** Who uploaded the file — the AI loop treats other people's files as untrusted content. */
  uploaderId: number | null
}

export async function listReadyKnowledgeBrief(workspaceId: string): Promise<KnowledgeBrief[]> {
  const db = useDatabase()
  return db.select({
    knowledgeId: workspaceKnowledge.knowledgeId,
    filename: workspaceKnowledge.filename,
    sizeBytes: workspaceKnowledge.sizeBytes,
    sourceExt: workspaceKnowledge.sourceExt,
    tokenCount: workspaceKnowledge.tokenCount,
    uploaderId: workspaceKnowledge.uploaderId
  }).from(workspaceKnowledge)
    .where(and(
      eq(workspaceKnowledge.workspaceId, workspaceId),
      eq(workspaceKnowledge.status, 'ready')
    ))
    .orderBy(desc(workspaceKnowledge.createdAt))
}

export async function getKnowledge(knowledgeId: string): Promise<KnowledgeRow | null> {
  const db = useDatabase()
  const rows = await db.select(LIST_COLUMNS).from(workspaceKnowledge)
    .where(eq(workspaceKnowledge.knowledgeId, knowledgeId))
    .limit(1)
  return rows[0] ?? null
}

export async function getKnowledgeWithMarkdown(knowledgeId: string): Promise<(KnowledgeRow & { markdownCache: string | null }) | null> {
  const db = useDatabase()
  const rows = await db.select({
    ...LIST_COLUMNS,
    markdownCache: workspaceKnowledge.markdownCache
  }).from(workspaceKnowledge)
    .where(eq(workspaceKnowledge.knowledgeId, knowledgeId))
    .limit(1)
  return rows[0] ?? null
}

export interface CreateKnowledgeInput {
  knowledgeId: string
  workspaceId: string
  filename: string
  sourceExt: string
  mimeType: string
  sizeBytes: number
  s3Key: string
  embeddingVersion: string
  uploaderId: number
}

export async function createKnowledge(input: CreateKnowledgeInput): Promise<void> {
  const db = useDatabase()
  await db.insert(workspaceKnowledge).values({
    ...input,
    status: 'processing' as const
  })
}

/**
 * Pick a non-colliding filename by appending `(2)`, `(3)`, … if needed.
 * Case-sensitive match (Postgres default). The unique index on
 * (workspaceId, filename) still protects against a race where two
 * uploads land on the same suffix — the caller should handle a 23505
 * by retrying.
 */
export async function disambiguateFilename(workspaceId: string, desired: string): Promise<string> {
  const db = useDatabase()
  const existing = await db.select({ filename: workspaceKnowledge.filename })
    .from(workspaceKnowledge)
    .where(eq(workspaceKnowledge.workspaceId, workspaceId))
  const taken = new Set(existing.map(r => r.filename))
  if (!taken.has(desired)) return desired
  const dot = desired.lastIndexOf('.')
  const base = dot > 0 ? desired.slice(0, dot) : desired
  const ext = dot > 0 ? desired.slice(dot) : ''
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error('disambiguateFilename: exhausted suffixes')
}

export async function countWorkspaceKnowledge(workspaceId: string): Promise<number> {
  const db = useDatabase()
  const rows = await db.select({ n: sql<number>`count(*)::int` })
    .from(workspaceKnowledge)
    .where(eq(workspaceKnowledge.workspaceId, workspaceId))
  return rows[0]?.n ?? 0
}

export async function sumWorkspaceKnowledgeBytes(workspaceId: string): Promise<number> {
  const db = useDatabase()
  const rows = await db.select({ total: sql<number>`coalesce(sum(size_bytes), 0)::bigint` })
    .from(workspaceKnowledge)
    .where(eq(workspaceKnowledge.workspaceId, workspaceId))
  return Number(rows[0]?.total ?? 0)
}

/**
 * Per-uploader counter across every workspace. Used to cap a single
 * user from fanning out — "upload 500 files into 10 workspaces each"
 * would fit inside every per-workspace cap but blow this one.
 *
 * Intentionally counts rows in ALL statuses (processing/ready/failed).
 * Failed rows still hold their S3 bytes until the sweep reaps them, so
 * they're fair game to count against the quota.
 */
export async function countKnowledgeByUploader(uploaderId: number, opts: { excludePooled?: boolean } = {}): Promise<number> {
  const db = useDatabase()
  const rows = await db.select({ n: sql<number>`count(*)::int` })
    .from(workspaceKnowledge)
    .where(uploaderCondition(uploaderId, opts.excludePooled === true))
  return rows[0]?.n ?? 0
}

export async function sumKnowledgeBytesByUploader(uploaderId: number, opts: { excludePooled?: boolean } = {}): Promise<number> {
  const db = useDatabase()
  const rows = await db.select({ total: sql<number>`coalesce(sum(size_bytes), 0)::bigint` })
    .from(workspaceKnowledge)
    .where(uploaderCondition(uploaderId, opts.excludePooled === true))
  return Number(rows[0]?.total ?? 0)
}

/**
 * Rows of one uploader; with `excludePooled`, without the files in Team /
 * Business workspaces (those count against the workspace pool, WP3).
 */
function uploaderCondition(uploaderId: number, excludePooled: boolean) {
  const byUploader = eq(workspaceKnowledge.uploaderId, uploaderId)
  return excludePooled
    ? and(byUploader, sql`${workspaceKnowledge.workspaceId} not in ${pooledWorkspaceIdsSubquery()}`)
    : byUploader
}

export async function deleteKnowledgeRow(knowledgeId: string): Promise<void> {
  const db = useDatabase()
  await db.delete(workspaceKnowledge)
    .where(eq(workspaceKnowledge.knowledgeId, knowledgeId))
}

/**
 * Every original key a knowledge row points at (any status). The
 * orphan sweep keeps exactly these and deletes other knowledge objects.
 */
export async function listAllKnowledgeS3Keys(): Promise<string[]> {
  const db = useDatabase()
  const rows = await db.select({ s3Key: workspaceKnowledge.s3Key }).from(workspaceKnowledge)
  return rows.map(r => r.s3Key)
}

export interface SearchHit {
  knowledgeId: string
  filename: string
  chunkIndex: number
  content: string
  /** Cosine similarity (1 = identical direction), or 0 if only BM25 matched. */
  similarity: number
  /** ts_rank_cd score, or 0 if only vector matched. */
  textScore: number
  /** Combined RRF score actually used for ordering. */
  rrfScore: number
}

// RRF constant. 60 is the value used in the original Cormack et al.
// paper and copied widely — small enough that top-ranked items
// dominate, large enough that rank-4 in one list still counts against
// rank-1 in the other. Don't tune this; if recall is bad, add a source
// (title-match, recency) or tune the candidate pool instead.
const RRF_K = 60

/**
 * Hybrid search across a workspace's chunks, combining:
 *   - Vector cosine similarity (via pgvector / HNSW) — good for
 *     semantic / paraphrased queries.
 *   - Postgres BM25-style `ts_rank_cd` over a generated tsvector —
 *     good for exact-phrase / jargon queries ("section 4.3",
 *     "cross-entropy loss").
 *
 * Results are merged via Reciprocal Rank Fusion: each source
 * contributes `1 / (RRF_K + rank)` per chunk, summed. Chunks that only
 * appear in one source still place reasonably; chunks that show up in
 * both get a natural boost.
 *
 * We pull a candidate pool (`candidatePool`, default 4 × topK) from
 * each source, fuse in JS, then cut to topK. Two round-trips instead
 * of a single SQL CTE — simpler, and easy to test against either
 * source in isolation.
 *
 * The BM25 pass is guarded: if `websearch_to_tsquery` returns an empty
 * query (the whole input was stopwords or punctuation) we skip it
 * rather than hit the GIN with an empty tsquery.
 */
export async function searchKnowledge(args: {
  workspaceId: string
  queryText: string
  queryEmbedding: number[]
  topK: number
  candidatePool?: number
  similarityThreshold?: number
}): Promise<SearchHit[]> {
  const db = useDatabase()
  const pool = Math.max(args.topK, args.candidatePool ?? args.topK * 4)
  const threshold = args.similarityThreshold ?? 0

  const similarity = sql<number>`1 - (${cosineDistance(workspaceKnowledgeChunks.embedding, args.queryEmbedding)})`

  // Pass 1 — vector. Candidate-pool sized so the HNSW index returns
  // enough spread for RRF to combine meaningfully.
  //
  // NaN guard: a chunk with a zero embedding (corruption, manual seed,
  // future ingest bug) produces NaN cosineDistance against a non-zero
  // query. Postgres breaks IEEE — `NaN > 0.5` returns TRUE and `ORDER
  // BY DESC` puts NaN at the TOP — so a single corrupt row would
  // dominate every workspace search. Filter NaN out explicitly. The
  // ingest pipeline shouldn't produce zero vectors today, but the
  // query-side guard is a one-liner defense in depth.
  const notNan = sql`${similarity} != 'NaN'::float8`
  const vectorPromise = db.select({
    knowledgeId: workspaceKnowledgeChunks.knowledgeId,
    filename: workspaceKnowledge.filename,
    chunkIndex: workspaceKnowledgeChunks.chunkIndex,
    content: workspaceKnowledgeChunks.content,
    similarity
  }).from(workspaceKnowledgeChunks)
    .innerJoin(workspaceKnowledge, eq(workspaceKnowledgeChunks.knowledgeId, workspaceKnowledge.knowledgeId))
    .where(and(
      eq(workspaceKnowledgeChunks.workspaceId, args.workspaceId),
      threshold > 0 ? sql`${notNan} AND ${similarity} > ${threshold}` : notNan
    ))
    .orderBy(desc(similarity))
    .limit(pool)

  // Pass 2 — BM25-style. `websearch_to_tsquery` is lenient: it handles
  // free-form input including OR-ed terms, quoted phrases, and negated
  // words without hand-parsing. If the input is all stopwords the
  // query is empty; `content_tsv @@ q` returns false and we just get
  // zero rows — the RRF still works with a single source.
  const tsQuery = sql`websearch_to_tsquery('english', ${args.queryText})`
  const textScore = sql<number>`ts_rank_cd(${workspaceKnowledgeChunks.contentTsv}, ${tsQuery})`

  const textPromise = db.select({
    knowledgeId: workspaceKnowledgeChunks.knowledgeId,
    filename: workspaceKnowledge.filename,
    chunkIndex: workspaceKnowledgeChunks.chunkIndex,
    content: workspaceKnowledgeChunks.content,
    textScore
  }).from(workspaceKnowledgeChunks)
    .innerJoin(workspaceKnowledge, eq(workspaceKnowledgeChunks.knowledgeId, workspaceKnowledge.knowledgeId))
    .where(and(
      eq(workspaceKnowledgeChunks.workspaceId, args.workspaceId),
      sql`${workspaceKnowledgeChunks.contentTsv} @@ ${tsQuery}`
    ))
    .orderBy(desc(textScore))
    .limit(pool)

  const [vectorHits, textHits] = await Promise.all([vectorPromise, textPromise])

  // RRF fusion. Key is (knowledgeId, chunkIndex) — ensures chunks
  // appearing in both sources merge instead of duplicating.
  type Row = SearchHit
  const byKey = new Map<string, Row>()
  const keyOf = (r: { knowledgeId: string, chunkIndex: number }) => `${r.knowledgeId}#${r.chunkIndex}`

  vectorHits.forEach((hit, i) => {
    const k = keyOf(hit)
    const rrf = 1 / (RRF_K + (i + 1))
    byKey.set(k, {
      knowledgeId: hit.knowledgeId,
      filename: hit.filename,
      chunkIndex: hit.chunkIndex,
      content: hit.content,
      similarity: hit.similarity,
      textScore: 0,
      rrfScore: rrf
    })
  })
  textHits.forEach((hit, i) => {
    const k = keyOf(hit)
    const rrf = 1 / (RRF_K + (i + 1))
    const prev = byKey.get(k)
    if (prev) {
      prev.textScore = hit.textScore
      prev.rrfScore += rrf
    } else {
      byKey.set(k, {
        knowledgeId: hit.knowledgeId,
        filename: hit.filename,
        chunkIndex: hit.chunkIndex,
        content: hit.content,
        similarity: 0,
        textScore: hit.textScore,
        rrfScore: rrf
      })
    }
  })

  return [...byKey.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, args.topK)
}
