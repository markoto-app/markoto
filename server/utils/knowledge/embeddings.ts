import type OpenAI from 'openai'
import { useLitellmAdmin } from '../ai/litellmClient'
import { FEATURE_TAGS, featureMetadata } from '../litellm/featureTags'
import {
  DEFAULT_EMBEDDINGS_DIMS,
  DEFAULT_EMBEDDINGS_MODEL,
  embeddingRequestParams,
  isJinaModel,
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
 * default `jina-embeddings-v5-text-nano` (768-d); a self-hoster can point the
 * proxy's `custom-embeddings` deployment at any OpenAI-compatible endpoint
 * and pick the dimension (see docs/AI-MODELS.md#embeddings). Same code path,
 * differences only through configuration.
 *
 * Behaviour:
 *   - Pin model + dimensionality from the typed env so all calls produce
 *     vectors in one space (per-call drift breaks `1 - cosineDistance`).
 *   - Provider-specific request parameters (Jina `task` hint, OpenAI
 *     `dimensions`) are decided in `shared/utils/runtime/embeddingConfig.ts`: sent
 *     for Jina models, opt-in for everything else.
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

/** `jina` = a Jina model (task hint + dimensions sent by default);
 *  `custom` = any other model behind LiteLLM. */
export type EmbeddingsProvider = 'jina' | 'custom'

const CONCURRENCY = 5

// Per-input character cap. Our chunker targets 800 with a 1500 ceiling —
// this is belt-and-braces for any caller that hands us pre-chunked text we
// didn't produce, and keeps us under the context window of small local
// models (nomic-embed-text: 2048 tokens).
const MAX_INPUT_CHARS = 8000 // ~2000 tokens worst case in English

export interface EmbeddingsConfig {
  provider: EmbeddingsProvider
  /** LiteLLM model name the app asks for (e.g. `jina-embeddings-v5-text-nano`
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
    provider: isJinaModel(model) ? 'jina' : 'custom',
    model,
    upstreamModel: raw.upstreamModel || '',
    dimensions: parseEmbeddingDims(raw.dims ?? DEFAULT_EMBEDDINGS_DIMS),
    shape: resolveRequestShape(model, {
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

function truncate(text: string): string {
  if (text.length <= MAX_INPUT_CHARS) return text
  return text.slice(0, MAX_INPUT_CHARS)
}

async function embedOne(
  client: OpenAI,
  cfg: EmbeddingsConfig,
  text: string,
  taskType: EmbeddingTaskType
): Promise<number[]> {
  // Optional request fields ride in as a typed spread (spread members
  // aren't excess-property-checked) so the SDK's typed fields keep their
  // literal types — in particular `encoding_format: 'float'`, which
  // selects the `number[]` overload of `create`. `task` (Jina) is not in
  // the SDK's types but LiteLLM forwards unknown body params upstream
  // verbatim; `dimensions` IS typed. Which of the two a model gets is
  // decided by `embeddingRequestParams` (Jina: both; others: opt-in).
  // The spend-tag for /admin/ai-spend aggregation rides on the same path.
  const extras = {
    ...embeddingRequestParams(cfg.shape, cfg.dimensions, taskType),
    ...featureMetadata(FEATURE_TAGS.embeddings)
  }
  const response = await client.embeddings.create({
    ...extras,
    model: cfg.model,
    input: truncate(text),
    // The OpenAI SDK defaults to `encoding_format: 'base64'`; with Jina via
    // LiteLLM that returns a truncated 192-d vector instead of the
    // requested 768-d. Force `'float'`.
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
