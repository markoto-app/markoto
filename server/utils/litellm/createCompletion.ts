import type OpenAI from 'openai'
import { isBudgetExceededError } from './userKeys'

// Typed wrapper around `litellm.chat.completions.create(...)` that carries
// LiteLLM's body extensions AND retries transient upstream throttles (429)
// transparently.
//
// The OpenAI SDK types `ChatCompletionCreateParams['metadata']` as `Metadata`
// (= `Record<string, string>`). LiteLLM extends this with `{ tags: string[] }`
// for spend-attribution tags, structurally incompatible with the base type, // plus the clientside `api_key` / `api_base`. The SDK gets the standard
// fields as its typed params and the full LiteLLM body through its `body`
// request option (which replaces the serialized body), so no cast hides a
// type error in the body.
//
// Retry semantics: applies to both wrappers below:
//   - 429 from upstream (Mistral / BFL) is RETRIED with
//     exponential backoff (3s, 6s, 12s, 24s, total ≤45s for 4
//     retries). Sized to ride out a full Mistral per-minute
//     rate-limit reset window even on sustained throttling, NOT
//     just transient bursts. Honors the `Retry-After` header when
//     the upstream supplies one.
//   - LiteLLM budget_exceeded errors are NOT retried, they're a
//     correctness signal we want to surface (caller catches and
//     emits the upgrade-CTA breadcrumb).
//   - AbortSignal aborts immediately; in-flight backoff is cancelled.
//   - All other errors propagate on the first attempt.
//
// Why retry here, not at every call site: upstream providers are bursty
// and have per-minute limits, and surfacing every throttle as a "Could
// not reach markoto" error is worse than the loop blocking on backoff.
// One retry covers transient blips; the 4-retry budget covers sustained
// throttling within a single rate-limit window.
//
// The waitForAiIdle default in `tests/e2e/page-objects/Editor.ts` is
// sized (150s) to absorb up to ~2 max-budget retries chained across
// the agentic loop's 4-6 LiteLLM calls.

const MAX_RETRIES = 4
const BACKOFF_BASE_MS = 3000

interface RetryableError {
  status?: number
  headers?: Record<string, string | undefined> | { get?: (k: string) => string | null }
}

/**
 * For a 429: the wait the upstream asked for in ms (`Retry-After`, seconds),
 * 0 when it named none. null for any other error.
 */
export function rateLimitRetryAfterMs(e: unknown): number | null {
  const re = e as RetryableError
  if (re.status !== 429) return null
  const headers = re.headers
  let raw: string | null | undefined
  if (headers && typeof (headers as { get?: (k: string) => string | null }).get === 'function') {
    raw = (headers as { get: (k: string) => string | null }).get('retry-after')
  } else if (headers && typeof headers === 'object') {
    raw = (headers as Record<string, string | undefined>)['retry-after']
  }
  if (!raw) return 0
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n * 1000 : 0
}

export async function sleepCancellable(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    }
    if (signal?.aborted) {
      clearTimeout(t)
      reject(new Error('aborted'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function withRetry<T>(
  attempt: () => Promise<T>,
  opts?: { signal?: AbortSignal }
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      return await attempt()
    } catch (e) {
      lastErr = e
      // Budget exhaustion is correctness, not flake, never retry.
      if (isBudgetExceededError(e)) throw e
      const retryAfterHint = rateLimitRetryAfterMs(e)
      if (retryAfterHint === null) throw e // not a 429
      if (i === MAX_RETRIES) throw e // out of attempts
      const backoff = retryAfterHint > 0 ? retryAfterHint : BACKOFF_BASE_MS * Math.pow(2, i)
      await sleepCancellable(backoff, opts?.signal)
    }
  }
  // Unreachable: the loop either returns or throws.
  throw lastErr
}

/**
 * LiteLLM request-body extensions beyond the OpenAI shape:
 *   - `metadata.tags`: four-axis spend tags (featureTags.ts).
 *   - `api_key` / `api_base`, clientside (BYOK) credentials. Only valid
 *     together with a `byok/*` model; build them with
 *     `providerRequestFields()` (server/utils/aiProviders/requestFields.ts),
 *     which also re-runs the SSRF policy on the base URL.
 */
interface LitellmBodyExtensions {
  metadata?: { tags: string[] }
  api_key?: string
  api_base?: string
}

export type LitellmCreateNonStreamParams = Omit<
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  'metadata'
> & LitellmBodyExtensions

export type LitellmCreateStreamParams = Omit<
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
  'metadata'
> & LitellmBodyExtensions

export type LitellmImageParams = Omit<OpenAI.Images.ImageGenerateParamsNonStreaming, 'metadata'> & LitellmBodyExtensions

/** The OpenAI-shaped part of a LiteLLM body (the SDK's typed params). */
function sdkParams<T extends LitellmBodyExtensions>(body: T): Omit<T, keyof LitellmBodyExtensions> {
  const { metadata: _metadata, api_key: _apiKey, api_base: _apiBase, ...params } = body
  return params
}

/**
 * Image generation through LiteLLM's `/v1/images/generations` (BYOK
 * path: the user's OpenAI-compatible images API). Uses the SDK's
 * generic `post` because the typed `images.generate` rejects LiteLLM's
 * body extensions. Same 429 retry policy as the chat wrappers.
 */
export async function litellmImage(
  client: OpenAI,
  body: LitellmImageParams,
  opts?: { signal?: AbortSignal }
): Promise<OpenAI.Images.ImagesResponse> {
  return withRetry(
    () => client.post<OpenAI.Images.ImagesResponse>('/images/generations', { body, signal: opts?.signal }),
    opts
  )
}

/**
 * One-shot transcription through LiteLLM's `/v1/audio/transcriptions`
 * (BYOK path). The form carries `model` + the clientside credential
 * fields next to the audio file, verified that LiteLLM v1.106.4 reads
 * `api_key` / `api_base` from multipart form fields.
 */
export async function litellmTranscription(
  client: OpenAI,
  form: FormData,
  opts?: { signal?: AbortSignal }
): Promise<{ text?: string }> {
  return withRetry(
    () => client.post<{ text?: string }>('/audio/transcriptions', { body: form, signal: opts?.signal }),
    opts
  )
}

/**
 * Non-streaming chat completion through LiteLLM. Use when you need the
 * full response in one shot, e.g. `web_search` / `fetch_url` synthesis,
 * voice transcribe, voice-tick billing.
 *
 * `maxRetries` overrides the OpenAI SDK's own retries (2 by default, on
 * 5xx and connection errors) for a call that must not be repeated blindly,
 * such as a paid image generation the provider may already have accepted.
 */
export async function litellmCompletion(
  client: OpenAI,
  body: LitellmCreateNonStreamParams,
  opts?: { signal?: AbortSignal, maxRetries?: number }
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const requestOptions = {
    signal: opts?.signal,
    body,
    ...(opts?.maxRetries === undefined ? {} : { maxRetries: opts.maxRetries })
  }
  return withRetry(
    () => client.chat.completions.create(sdkParams(body), requestOptions),
    opts
  )
}

/**
 * Streaming chat completion through LiteLLM. Use for the agentic loop's
 * main turn-by-turn streaming where we read tool-call deltas as they
 * arrive. Returns an `AsyncIterable<ChatCompletionChunk>` instead of the
 * SDK's `Stream<...>`: the chunk-translator in `messageTranslation.ts`
 * only consumes the iterator interface.
 */
export async function litellmStream(
  client: OpenAI,
  body: LitellmCreateStreamParams,
  opts?: {
    signal?: AbortSignal
    /**
     * The caller retries itself (the agentic loop: `loop/rateLimitRetry.ts`
     * for 429s, `streamTurn`'s transport retry for the rest). Then neither
     * this wrapper's 429 backoff nor the SDK's own retries run, so one
     * throttle is not retried by three layers at once.
     */
    callerRetries?: boolean
  }
): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
  if (opts?.callerRetries) {
    return client.chat.completions.create(sdkParams(body), { signal: opts.signal, body, maxRetries: 0 })
  }
  // 429 surfaces synchronously from the SDK before the stream starts,
  // retrying here covers the "I never got a single chunk" failure
  // mode. A 429 mid-stream (rare; happens if the proxy bills as you
  // go) would NOT be caught here, but we have no resumption strategy
  // for that anyway and the caller's existing error handler is the
  // right surface.
  return withRetry(
    () => client.chat.completions.create(sdkParams(body), { signal: opts?.signal, body }),
    opts
  )
}
