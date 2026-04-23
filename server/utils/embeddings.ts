import { GoogleGenAI } from '@google/genai'

/**
 * Gemini embeddings wrapper for the workspace knowledge base. Thin layer
 * over `ai.models.embedContent` that:
 *
 *   - Pins the model + output dimensionality from runtimeConfig so every
 *     call in the codebase produces vectors that share one space. Writing
 *     `embed_documents` and `embed_query` in different places would drift.
 *   - Batches document embedding so a 200-chunk PDF doesn't do 200 round
 *     trips. Gemini accepts arrays in `contents`.
 *   - Picks the right `taskType` per call site. `RETRIEVAL_DOCUMENT` for
 *     corpus chunks, `RETRIEVAL_QUERY` for incoming search strings.
 *     Gemini's task-type hints measurably improve recall over treating
 *     both identically (docs + queries live on slightly different
 *     sub-manifolds of the embedding space).
 *   - Stamps results with an `embeddingVersion` string the caller persists
 *     next to the vector, so we can re-embed lazily if we ever bump model
 *     or dims without a destructive migration.
 *
 * Note on dimensions: Gemini supports MRL truncation via
 * `outputDimensionality`. We default to 768 — pgvector HNSW caps at 2000
 * dims (3072 forces IVFFlat), and 768 is Gemini's lowest "recommended"
 * tier with marginal recall loss for the doc-retrieval use case. Bumping
 * requires: (1) recreate the HNSW index with the new dim, (2) bump
 * `embeddingVersion` so stale chunks are detected, (3) either mass
 * re-embed or accept mixed-era vectors (the `1 - cosineDistance`
 * ordering stays roughly monotonic across tiers but isn't strictly
 * comparable).
 */

export type EmbeddingTaskType
  = | 'RETRIEVAL_DOCUMENT'
    | 'RETRIEVAL_QUERY'
    | 'SEMANTIC_SIMILARITY'
    | 'CLASSIFICATION'
    | 'CLUSTERING'

// The JS `@google/genai` SDK treats `contents: [text1, text2, …]` as a
// SINGLE multi-part Content and returns ONE aggregate embedding — not
// one embedding per input string (that's the Python SDK's behaviour).
// To get per-chunk vectors we have to call `embedContent` once per text.
// Small concurrency (5) keeps throughput reasonable for large PDFs
// without provoking 429s on shared keys.
const CONCURRENCY = 5

// Per-input token cap. gemini-embedding-001/2-preview both cap at 2048.
// Our chunker targets 800 with hard-cap at 1500 — this is belt-and-braces
// for any caller that hands us pre-chunked text we didn't produce.
const MAX_INPUT_CHARS = 8000 // ~2000 tokens in English worst case

export interface EmbeddingsConfig {
  model: string
  dimensions: number
  apiKey: string
}

export function resolveEmbeddingsConfig(): EmbeddingsConfig {
  const config = useRuntimeConfig()
  const apiKey = config.google.geminiApiKey
  if (!apiKey) {
    throw new Error('[embeddings] NUXT_GOOGLE_GEMINI_API_KEY not configured')
  }
  return {
    model: config.google.embeddingModel,
    dimensions: config.google.embeddingDims,
    apiKey
  }
}

/** Stable identifier persisted with each row so we can detect stale vectors. */
export function embeddingVersionTag(cfg: EmbeddingsConfig): string {
  return `${cfg.model}:${cfg.dimensions}`
}

function truncate(text: string): string {
  if (text.length <= MAX_INPUT_CHARS) return text
  return text.slice(0, MAX_INPUT_CHARS)
}

/** Embed one text. The JS SDK returns exactly one vector per call. */
async function embedOne(
  ai: GoogleGenAI,
  cfg: EmbeddingsConfig,
  text: string,
  taskType: EmbeddingTaskType
): Promise<number[]> {
  const response = await ai.models.embedContent({
    model: cfg.model,
    contents: truncate(text),
    config: {
      outputDimensionality: cfg.dimensions,
      taskType
    }
  })
  const values = response.embeddings?.[0]?.values
  if (!values || values.length !== cfg.dimensions) {
    throw new Error(`[embeddings] vector has wrong shape: ${values?.length ?? 0} != ${cfg.dimensions}`)
  }
  return values
}

/**
 * Embed a list of document chunks for the corpus. Runs a bounded
 * concurrency pool of per-chunk calls — the JS SDK does NOT expose a
 * true batch mode that returns one vector per input (unlike the Python
 * SDK). Order of the returned vectors matches the input order.
 */
export async function embedDocuments(
  texts: string[],
  opts: { ai?: GoogleGenAI, config?: EmbeddingsConfig, concurrency?: number } = {}
): Promise<number[][]> {
  const cfg = opts.config ?? resolveEmbeddingsConfig()
  const ai = opts.ai ?? new GoogleGenAI({ apiKey: cfg.apiKey })
  const concurrency = Math.max(1, opts.concurrency ?? CONCURRENCY)
  const out: number[][] = new Array(texts.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= texts.length) return
      out[i] = await embedOne(ai, cfg, texts[i]!, 'RETRIEVAL_DOCUMENT')
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, texts.length) }, worker)
  await Promise.all(workers)
  return out
}

/**
 * Embed a single query string. Always a 1-item call — query latency is
 * user-facing and batching is pointless here.
 */
export async function embedQuery(
  text: string,
  opts: { ai?: GoogleGenAI, config?: EmbeddingsConfig } = {}
): Promise<number[]> {
  const cfg = opts.config ?? resolveEmbeddingsConfig()
  const ai = opts.ai ?? new GoogleGenAI({ apiKey: cfg.apiKey })
  return embedOne(ai, cfg, text, 'RETRIEVAL_QUERY')
}
