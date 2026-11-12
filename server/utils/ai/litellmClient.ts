import OpenAI from 'openai'
import { trimTrailingSlashes } from '../../../shared/utils/trimTrailingSlashes'
import { useEnv } from '~~/shared/env/load'

/**
 * Thin OpenAI-SDK factory pointed at our self-hosted LiteLLM proxy.
 *
 * LiteLLM speaks OpenAI's API shape for chat / embeddings / images /
 * audio, so the official `openai` SDK Just Works against it — we don't
 * need a vendor-specific client per provider. The proxy handles routing,
 * cost tracking, and per-user budget enforcement.
 *
 * `useLitellmAdmin()` uses the master key for system-level operations
 * (ingest re-embed, search-time query embedding); `useLitellmForUser()`
 * uses a per-user virtual key.
 *
 * Don't confuse with `server/utils/ai/aiClient.ts` — that's the Y.js AI
 * session client (joins Hocuspocus as the `ai:assistant:*` principal).
 * Both files are needed: the LiteLLM client emits LLM HTTP calls; the
 * Y.js client owns the AI's CRDT identity inside a doc.
 */

let cachedAdminClient: OpenAI | null = null

/**
 * Returns an OpenAI SDK client authenticated with the LiteLLM master key.
 * Use for system operations (ingest pipelines, sweepers, admin endpoints).
 * For user-attributed calls, use `useLitellmForUser(virtualKey)`.
 *
 * The client is cached across calls — the SDK manages its own keep-alive
 * connection pool.
 */
export function useLitellmAdmin(): OpenAI {
  if (cachedAdminClient) return cachedAdminClient
  const env = useEnv()
  const url = env.litellm.url
  const masterKey = env.litellm.masterKey
  if (!url || !masterKey) {
    throw new Error('[litellm] NUXT_LITELLM_URL and NUXT_LITELLM_MASTER_KEY must be set')
  }
  cachedAdminClient = new OpenAI({
    apiKey: masterKey,
    // OpenAI SDK appends `/v1` paths internally; LiteLLM accepts both
    // `/v1/...` and bare `/...` so passing the bare base URL is correct.
    baseURL: trimTrailingSlashes(url) + '/v1'
  })
  return cachedAdminClient
}

/**
 * Returns an OpenAI SDK client authenticated with a per-user virtual key.
 * Constructs a fresh client per call (no cache, since virtual keys differ
 * per user).
 */
export function useLitellmForUser(virtualKey: string): OpenAI {
  const env = useEnv()
  const url = env.litellm.url
  if (!url) {
    throw new Error('[litellm] NUXT_LITELLM_URL not configured')
  }
  return new OpenAI({
    apiKey: virtualKey,
    baseURL: trimTrailingSlashes(url) + '/v1'
  })
}

/** Test-only: drops the cached admin client so the next call reads the env again. */
export function _resetLitellmCache(): void {
  cachedAdminClient = null
}
