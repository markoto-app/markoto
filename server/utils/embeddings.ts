import type OpenAI from 'openai'
import { useLitellmAdmin } from './litellmClient'
import { FEATURE_TAGS, featureMetadata } from './litellm/featureTags'

/**
 * Embeddings wrapper for the workspace knowledge base.
 *
 * Phase 5: routes through the LiteLLM proxy → `jina-embeddings-v5-text-nano`
 * at 768-d. Pre-Phase-5 (Gemini-era) the path was direct `@google/genai`
 * `embedContent`; that path was removed once every shipped chunk migrated
 * to Jina vectors via `scripts/re-embed-knowledge.ts`. The script itself
 * stays for any future re-embed (model bump, dim change, vendor swap).
 *
 * Public API is provider-agnostic: callsites in `processKnowledge.ts`,
 * `repos/knowledge.ts`, and `scripts/re-embed-knowledge.ts` use the same
 * `embedDocuments` / `embedQuery` signature.
 *
 * Behaviour:
 *   - Pin model + dimensionality from runtimeConfig so all calls produce
 *     vectors in one space (per-call drift breaks `1 - cosineDistance`).
 *   - Apply the same per-input character cap (defends against pre-chunked
 *     input that exceeds the model's token window).
 *   - Use bounded concurrency (5) for batch document embedding. We don't
 *     exploit Jina's true batch endpoint — the per-call shape is uniform
 *     enough that the extra pool plumbing isn't worth it at our scale.
 *   - Stamp results with an `embeddingVersion` string the caller persists
 *     so we can re-embed lazily if model or dims ever change without a
 *     destructive migration.
 *
 * On dimensions: pgvector HNSW caps at 2000 dims. We pin 768 because Jina
 * v5-text-nano's native dimensionality is 768 — no MRL truncation, no
 * loss vs the model's full output.
 */

export type EmbeddingTaskType
  = | 'RETRIEVAL_DOCUMENT'
    | 'RETRIEVAL_QUERY'
    | 'SEMANTIC_SIMILARITY'
    | 'CLASSIFICATION'
    | 'CLUSTERING'

/** Type alias retained for callers (notably `re-embed-knowledge.ts`).
 *  Single-valued post-Phase-5 — kept as a type alias rather than a string
 *  literal in case we add a second backend (e.g. local Ollama) later. */
export type EmbeddingsProvider = 'jina'

const CONCURRENCY = 5

// Per-input character cap. Jina v5-text-nano has a large token window
// (≥2k); our chunker targets 800 with a 1500 ceiling — this is
// belt-and-braces for any caller that hands us pre-chunked text we
// didn't produce.
const MAX_INPUT_CHARS = 8000 // ~2000 tokens worst case in English

export interface EmbeddingsConfig {
  /** Backend selection. Single-valued today; kept on the shape so the
   *  re-embed script signals intent at the boundary. */
  provider: EmbeddingsProvider
  /** Provider-specific model id (e.g. `jina-embeddings-v5-text-nano`). */
  model: string
  /** Output vector dimension. */
  dimensions: number
  /** LiteLLM master key (used as the OpenAI SDK's apiKey). */
  apiKey: string
}

export function resolveEmbeddingsConfig(): EmbeddingsConfig {
  const config = useRuntimeConfig()
  const apiKey = config.litellm?.masterKey
  if (!apiKey) {
    throw new Error('[embeddings] NUXT_LITELLM_MASTER_KEY required')
  }
  return {
    provider: 'jina',
    model: config.litellm?.embeddingsModel || 'jina-embeddings-v5-text-nano',
    dimensions: config.litellm?.embeddingsDims || 768,
    apiKey
  }
}

/**
 * Stable identifier persisted with each row so re-embed jobs can detect
 * stale vectors. Format: `{provider}/{model}:{dims}`.
 */
export function embeddingVersionTag(cfg: EmbeddingsConfig): string {
  return `${cfg.provider}/${cfg.model}:${cfg.dimensions}`
}

function truncate(text: string): string {
  if (text.length <= MAX_INPUT_CHARS) return text
  return text.slice(0, MAX_INPUT_CHARS)
}

/**
 * Map our internal task-type enum to Jina's. Jina's `task` parameter is
 * a top-level field on `/v1/embeddings` (NOT `extra_body` as the LiteLLM
 * docs imply for the OpenAI shim); spike confirmed it propagates.
 *
 * RETRIEVAL_DOCUMENT → retrieval.passage (corpus chunks)
 * RETRIEVAL_QUERY    → retrieval.query   (search-time query)
 * Other task types fall back to text-matching, Jina's symmetric default.
 */
function mapTaskToJina(task: EmbeddingTaskType): string {
  switch (task) {
    case 'RETRIEVAL_DOCUMENT': return 'retrieval.passage'
    case 'RETRIEVAL_QUERY': return 'retrieval.query'
    default: return 'text-matching'
  }
}

async function embedOne(
  client: OpenAI,
  cfg: EmbeddingsConfig,
  text: string,
  taskType: EmbeddingTaskType
): Promise<number[]> {
  // The OpenAI SDK's `embeddings.create` doesn't have a typed `task`
  // field, but LiteLLM forwards unknown body params to the upstream
  // provider verbatim. They ride in as a typed spread (spread members
  // aren't excess-property-checked) so the SDK's typed fields keep their
  // literal types — in particular `encoding_format: 'float'`, which
  // selects the `number[]` overload of `create` (openai >= 7 overloads
  // on it; an `as any` extras object would collapse to the base64
  // overload). `dimensions` IS typed in the OpenAI SDK.
  //
  // Jina-specific: the task hint propagates through LiteLLM. Without
  // it v4's recall measurably degrades on retrieval workloads (verified
  // in Phase 0 spike — vectors differ across task values). The LiteLLM
  // spend-tag for /admin/ai-spend aggregation rides on the same path.
  const litellmExtras = {
    task: mapTaskToJina(taskType),
    ...featureMetadata(FEATURE_TAGS.embeddings)
  }
  const response = await client.embeddings.create({
    ...litellmExtras,
    model: cfg.model,
    input: truncate(text),
    dimensions: cfg.dimensions,
    // OpenAI SDK auto-injects `encoding_format: 'base64'` for
    // embeddings. With Jina via LiteLLM, that path returns a 192-d
    // truncated vector instead of the requested 768-d (silent
    // failure: code reads `data[0].embedding.length === 192`,
    // pgvector insert fails with "vector has wrong shape"). Force
    // `'float'` so Jina returns the number array directly.
    encoding_format: 'float'
  })
  const values = response.data?.[0]?.embedding
  if (values?.length !== cfg.dimensions) {
    throw new Error(`[embeddings] jina vector has wrong shape: ${values?.length ?? 0} != ${cfg.dimensions}`)
  }
  return values
}

// ─── Public API (unchanged shape) ─────────────────────────────────────────

export interface EmbedOptions {
  /** Override provider config (tests, scripts). */
  config?: EmbeddingsConfig
  /** Per-batch concurrency. Default 5. */
  concurrency?: number
  /** Pre-built LiteLLM client (tests). */
  litellm?: OpenAI
}

function resolveClient(opts: EmbedOptions): OpenAI {
  return opts.litellm ?? useLitellmAdmin()
}

/**
 * Embed a list of document chunks. Concurrent pool of per-chunk calls;
 * order of returned vectors matches input order.
 */
export async function embedDocuments(
  texts: string[],
  opts: EmbedOptions = {}
): Promise<number[][]> {
  const cfg = opts.config ?? resolveEmbeddingsConfig()
  const client = resolveClient(opts)
  const concurrency = Math.max(1, opts.concurrency ?? CONCURRENCY)
  const out: number[][] = new Array(texts.length)
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= texts.length) return
      out[i] = await embedOne(client, cfg, texts[i]!, 'RETRIEVAL_DOCUMENT')
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, texts.length) }, worker)
  await Promise.all(workers)
  return out
}

/**
 * Embed a single query string. Always 1-call — query latency is
 * user-facing, batching has no payoff here.
 */
export async function embedQuery(
  text: string,
  opts: EmbedOptions = {}
): Promise<number[]> {
  const cfg = opts.config ?? resolveEmbeddingsConfig()
  const client = resolveClient(opts)
  return embedOne(client, cfg, text, 'RETRIEVAL_QUERY')
}
