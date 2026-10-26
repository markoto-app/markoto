// Pure helpers for the embeddings configuration. No Nuxt auto-imports and no
// I/O, so the server, the re-embed script and the unit tests all share them.
//
// Hosted markoto runs the defaults (Jina v5-text-nano, 768 dims). A
// self-hoster can point the proxy at any OpenAI-compatible embeddings
// endpoint and pick the dimensionality — see docs/AI-MODELS.md#embeddings.

export const DEFAULT_EMBEDDINGS_MODEL = 'jina-embeddings-v5-text-nano'
export const DEFAULT_EMBEDDINGS_DIMS = 768

/**
 * LiteLLM model_name of the operator-configurable deployment in
 * `infra/litellm/config.yaml`. Its upstream model / api_base / api_key come
 * from the proxy's `EMBEDDINGS_UPSTREAM_*` environment variables.
 */
export const CUSTOM_EMBEDDINGS_MODEL = 'custom-embeddings'

/**
 * pgvector indexes a `vector` column with HNSW up to 2000 dimensions. The
 * column can hold more, but without an index every search is a sequential
 * scan, so we refuse to go beyond the limit. (`halfvec` indexes up to 4000
 * dimensions, but needs a different column type + query operators: not
 * supported.)
 */
export const MAX_EMBEDDING_DIMS = 2000

export type EmbeddingTaskType
  = | 'RETRIEVAL_DOCUMENT'
    | 'RETRIEVAL_QUERY'
    | 'SEMANTIC_SIMILARITY'
    | 'CLASSIFICATION'
    | 'CLUSTERING'

/** `auto` = decide from the model; `true` / `false` = operator override. */
export type TriState = 'auto' | 'true' | 'false'

/**
 * Validate the configured vector dimension. Accepts the number (nuxt
 * runtimeConfig coerces env strings to numbers when the default is a number)
 * or a numeric string (the re-embed script reads raw env). Throws with an
 * operator-actionable message; never returns NaN or a fractional value.
 */
export function parseEmbeddingDims(raw: unknown): number {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new Error(
      `NUXT_LITELLM_EMBEDDINGS_DIMS must be a positive integer (got ${JSON.stringify(raw)}).`
    )
  }
  if (n > MAX_EMBEDDING_DIMS) {
    throw new Error(
      `NUXT_LITELLM_EMBEDDINGS_DIMS=${n} exceeds ${MAX_EMBEDDING_DIMS}, the most dimensions pgvector can index with HNSW. `
      + `Pick a model or output size of at most ${MAX_EMBEDDING_DIMS} dimensions (many models accept a reduced size; see NUXT_LITELLM_EMBEDDINGS_SEND_DIMENSIONS).`
    )
  }
  return n
}

export function parseTriState(raw: unknown, name: string): TriState {
  if (raw === undefined || raw === null) return 'auto'
  const v = String(raw).trim().toLowerCase()
  if (v === '' || v === 'auto') return 'auto'
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return 'true'
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return 'false'
  throw new Error(`${name} must be one of auto | true | false (got ${JSON.stringify(raw)}).`)
}

export function isJinaModel(model: string): boolean {
  return model.toLowerCase().includes('jina')
}

/**
 * Jina's `task` parameter is a top-level field on `/v1/embeddings`.
 *
 * RETRIEVAL_DOCUMENT -> retrieval.passage (corpus chunks)
 * RETRIEVAL_QUERY    -> retrieval.query   (search-time query)
 * Other task types fall back to text-matching, Jina's symmetric default.
 */
export function mapTaskToJina(task: EmbeddingTaskType): string {
  switch (task) {
    case 'RETRIEVAL_DOCUMENT': return 'retrieval.passage'
    case 'RETRIEVAL_QUERY': return 'retrieval.query'
    default: return 'text-matching'
  }
}

/** Resolve a tri-state against the "auto" default for the model. */
export function resolveTriState(value: TriState, autoValue: boolean): boolean {
  if (value === 'auto') return autoValue
  return value === 'true'
}

export interface EmbeddingRequestShape {
  /** Send the Jina `task` hint. Default: only for Jina models. */
  sendTaskHint: boolean
  /** Send the OpenAI `dimensions` parameter. Default: only for Jina models. */
  sendDimensions: boolean
}

/**
 * Decide which optional request parameters a model gets. Both default to
 * "Jina only": the `task` hint is a Jina extension that other providers may
 * reject, and `dimensions` is rejected by most models (LiteLLM itself
 * answers 400 for non-`text-embedding-3` OpenAI-compatible models). When a
 * model's native output already has the configured size, neither is needed;
 * the vector-length check still catches any mismatch.
 */
export function resolveRequestShape(
  model: string,
  overrides: { sendTaskHint?: TriState, sendDimensions?: TriState } = {}
): EmbeddingRequestShape {
  const jina = isJinaModel(model)
  return {
    sendTaskHint: resolveTriState(overrides.sendTaskHint ?? 'auto', jina),
    sendDimensions: resolveTriState(overrides.sendDimensions ?? 'auto', jina)
  }
}

/** Optional request body fields for one embeddings call. */
export function embeddingRequestParams(
  shape: EmbeddingRequestShape,
  dimensions: number,
  taskType: EmbeddingTaskType
): { task?: string, dimensions?: number } {
  const out: { task?: string, dimensions?: number } = {}
  if (shape.sendTaskHint) out.task = mapTaskToJina(taskType)
  if (shape.sendDimensions) out.dimensions = dimensions
  return out
}
