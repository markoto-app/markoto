import type OpenAI from 'openai'
import { useLitellmAdmin } from '../ai/litellmClient'
import { FEATURE_TAGS, featureMetadata } from '../litellm/featureTags'
import {
  DEFAULT_EMBEDDINGS_DIMS,
  DEFAULT_EMBEDDINGS_MODEL,
  embeddingRequestParams,
  parseEmbeddingDims,
  parseTriState,
  resolveRequestShape,
  type EmbeddingRequestShape,
  type EmbeddingTaskType
} from '../../../shared/utils/runtime/embeddingConfig'
import { useEnv } from '~~/shared/env/load'

/**
 * Embeddings wrapper for the workspace knowledge base.
 *
 * Every call routes through the LiteLLM proxy. Hosted markoto uses the
 * default `mistral-embed` (1024-d, Mistral's EU endpoint); a self-hoster can point the
 * proxy's `custom-embeddings` deployment at any OpenAI-compatible endpoint
 * and pick the dimension (see docs/AI-MODELS.md#embeddings). Same code path,
 * differences only through configuration.
 *
 * Behaviour:
 *   - Pin model + dimensionality from the typed env so all calls produce
 *     vectors in one space (per-call drift breaks `1 - cosineDistance`).
 *   - Optional request parameters (`task` retrieval hint, OpenAI
 *     `dimensions`) are decided in `shared/utils/runtime/embeddingConfig.ts`:
 *     opt-in, never sent by default.
 *   - Apply the same per-input character cap (defends against pre-chunked
 *     input that exceeds the model's token window).
 *   - Use bounded concurrency (5) for batch document embedding.
 *   - Stamp results with an `embeddingVersion` string the caller persists
 *     so a model or dimension change can be detected and re-embedded.
 *
 * On dimensions: pgvector HNSW caps at 2000 dims (validated by
 * `parseEmbeddingDims`). The column's actual dimension is reconciled with
 * `NUXT_LITELLM_EMBEDDINGS_DIMS` at boot by `server/utils/knowledge/embeddingColumn.ts`.
 */

/** `mistral` = the bundled `mistral-embed` deployment;
 *  `custom` = any other model behind LiteLLM. */
export type EmbeddingsProvider = 'mistral' | 'custom'

const CONCURRENCY = 5

// Per-input cap, in UTF-8 bytes. Our chunker targets 800 estimated tokens
// with a 1500 ceiling; this is belt-and-braces for any caller that hands us
// pre-chunked text we didn't produce (or one unbroken run of text the
// chunker can't split). Byte-level BPE tokenizers (Mistral's included)
// never produce more tokens than the input has bytes, so 8000 bytes stays
// under `mistral-embed`'s hard 8192-token input limit (Mistral rejects a
// longer input instead of truncating it) for every script, CJK included.
// For English that is ~2000 tokens, inside the context window of small
// local models too (nomic-embed-text: 2048 tokens).
export const MAX_INPUT_BYTES = 8000

export interface EmbeddingsConfig {
  provider: EmbeddingsProvider
  /** LiteLLM model name the app asks for (e.g. `mistral-embed`
   *  or the operator-configurable `custom-embeddings`). */
  model: string
  /** Upstream model behind a custom deployment (`EMBEDDINGS_UPSTREAM_MODEL`),
   *  when known to the app. Only used to make the version tag meaningful. */
  upstreamModel: string
  /** Output vector dimension. */
  dimensions: number
  /** Which optional request parameters to send. */
  shape: EmbeddingRequestShape
  /** LiteLLM master key (used as the OpenAI SDK's apiKey). */
  apiKey: string
}

/** Raw settings, from the typed env or (re-embed script) the process env. */
export interface RawEmbeddingsSettings {
  model?: string
  upstreamModel?: string
  dims?: unknown
  sendDimensions?: unknown
  taskHints?: unknown
  apiKey?: string
}

/** Validate raw settings into a config. Shared by the app and the re-embed script. */
export function buildEmbeddingsConfig(raw: RawEmbeddingsSettings): EmbeddingsConfig {
  if (!raw.apiKey) {
    throw new Error('[embeddings] NUXT_LITELLM_MASTER_KEY required')
  }
  const model = raw.model || DEFAULT_EMBEDDINGS_MODEL
  return {
    provider: model === DEFAULT_EMBEDDINGS_MODEL ? 'mistral' : 'custom',
    model,
    upstreamModel: raw.upstreamModel || '',
    dimensions: parseEmbeddingDims(raw.dims ?? DEFAULT_EMBEDDINGS_DIMS),
    shape: resolveRequestShape({
      sendTaskHint: parseTriState(raw.taskHints, 'NUXT_LITELLM_EMBEDDINGS_TASK_HINTS'),
      sendDimensions: parseTriState(raw.sendDimensions, 'NUXT_LITELLM_EMBEDDINGS_SEND_DIMENSIONS')
    }),
    apiKey: raw.apiKey
  }
}

export function resolveEmbeddingsConfig(): EmbeddingsConfig {
  const { litellm } = useEnv()
  return buildEmbeddingsConfig({
    model: litellm.embeddingsModel,
    upstreamModel: litellm.embeddingsUpstreamModel,
    dims: litellm.embeddingsDims,
    sendDimensions: litellm.embeddingsSendDimensions,
    taskHints: litellm.embeddingsTaskHints,
    apiKey: litellm.masterKey
  })
}

/**
 * Stable identifier persisted with each row so re-embed jobs can detect
 * stale vectors. Format: `{provider}/{model}:{dims}`. For a custom
 * deployment the upstream model (when configured) replaces the generic
 * `custom-embeddings` alias so switching upstream models is detectable.
 */
export function embeddingVersionTag(cfg: EmbeddingsConfig): string {
  const model = cfg.provider === 'custom' && cfg.upstreamModel ? cfg.upstreamModel : cfg.model
  return `${cfg.provider}/${model}:${cfg.dimensions}`
}

/** Cut `text` to at most `MAX_INPUT_BYTES` UTF-8 bytes, never inside a character. */
export function truncateForEmbedding(text: string): string {
  // Fast path: even if every UTF-16 unit took 3 bytes it would fit.
  if (text.length * 3 <= MAX_INPUT_BYTES) return text
  let bytes = 0
  let end = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    if (bytes + size > MAX_INPUT_BYTES) break
    bytes += size
    end += ch.length
  }
  return text.slice(0, end)
}

async function embedOne(
  client: OpenAI,
  cfg: EmbeddingsConfig,
  text: string,
  taskType: EmbeddingTaskType
): Promise<number[]> {
  // Optional request fields ride in as a typed spread (spread members
  // aren't excess-property-checked) so the SDK's typed fields keep their
  // literal types: in particular `encoding_format: 'float'`, which
  // selects the `number[]` overload of `create`. `task` is not in the
  // SDK's types but LiteLLM forwards unknown body params upstream
  // verbatim; `dimensions` IS typed. Whether either is sent is decided by
  // `embeddingRequestParams` (opt-in, off by default).
  // The spend-tag for /admin/ai-spend aggregation rides on the same path.
  const extras = {
    ...embeddingRequestParams(cfg.shape, cfg.dimensions, taskType),
    ...featureMetadata(FEATURE_TAGS.embeddings)
  }
  const response = await client.embeddings.create({
    ...extras,
    model: cfg.model,
    input: truncateForEmbedding(text),
    // The OpenAI SDK defaults to `encoding_format: 'base64'`, which some
    // upstreams behind LiteLLM decode into a vector of the wrong length.
    // Force `'float'` (Mistral accepts it; verified through LiteLLM).
    encoding_format: 'float'
  })
  const values = response.data?.[0]?.embedding
  if (values?.length !== cfg.dimensions) {
    throw new Error(
      `[embeddings] ${cfg.model} returned a vector with wrong shape: ${values?.length ?? 0} dims, `
      + `but NUXT_LITELLM_EMBEDDINGS_DIMS=${cfg.dimensions}. Set it to the model's output size (then run the re-embed command), `
      + 'or enable NUXT_LITELLM_EMBEDDINGS_SEND_DIMENSIONS if the model supports reduced output sizes.'
    )
  }
  return values
}

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
      const text = texts[i]
      if (text === undefined) return
      out[i] = await embedOne(client, cfg, text, 'RETRIEVAL_DOCUMENT')
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, texts.length) }, worker)
  await Promise.all(workers)
  return out
}

/**
 * Embed a single query string. Always 1-call, query latency is
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
