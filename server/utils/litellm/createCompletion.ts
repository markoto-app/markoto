import type OpenAI from 'openai'
import { isBudgetExceededError } from './userKeys'

// Typed wrapper around `litellm.chat.completions.create(...)` that handles
// the cast for LiteLLM's `metadata.tags: string[]` extension AND retries
// transient upstream throttles (429) transparently.
//
// The OpenAI SDK types `ChatCompletionCreateParams['metadata']` as `Metadata`
// (= `Record<string, string>`). LiteLLM extends this with `{ tags: string[] }`
// for spend-attribution tags — structurally incompatible with the base type.
// Without a typed wrapper, every call site ended up writing
// `{...} as unknown as Parameters<typeof litellm.chat.completions.create>[0]`
// — a double cast that hides not just the metadata mismatch but ALL type
// errors in the body. These helpers narrow the cast to the metadata field
// alone; everything else stays type-checked.
//
// Retry semantics — applies to both wrappers below:
//   - 429 from upstream (Mistral / Jina / BFL) is RETRIED with
//     exponential backoff (3s, 6s, 12s, 24s — total ≤45s for 4
//     retries). Sized to ride out a full Mistral per-minute
//     rate-limit reset window even on sustained throttling, NOT
//     just transient bursts. Honors the `Retry-After` header when
//     the upstream supplies one.
//   - LiteLLM budget_exceeded errors are NOT retried — they're a
//     correctness signal we want to surface (caller catches and
//     emits the upgrade-CTA breadcrumb).
//   - AbortSignal aborts immediately; in-flight backoff is cancelled.
//   - All other errors propagate on the first attempt.
//
// Why retry here, not at every call site: the in-app AI's user-facing
// "Could not reach markoto" toast was firing on ANY upstream throttle
// (Mistral's free tier is bursty AND has per-minute limits). One retry
// covers transient blips; the 4-retry budget covers sustained
// throttling within a single rate-limit window. Production users get
// a calmer UX (loop blocks on backoff instead of erroring), AND our
// flow tests stop flaking when the test stack bursts ~30 AI calls
// against the proxy.
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

function get429RetryAfterMs(e: unknown): number | null {
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

async function sleepCancellable(ms: number, signal: AbortSignal | undefined): Promise<void> {
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
      // Budget exhaustion is correctness, not flake — never retry.
      if (isBudgetExceededError(e)) throw e
      const retryAfterHint = get429RetryAfterMs(e)
      if (retryAfterHint === null) throw e // not a 429
      if (i === MAX_RETRIES) throw e // out of attempts
      const backoff = retryAfterHint > 0 ? retryAfterHint : BACKOFF_BASE_MS * Math.pow(2, i)
      await sleepCancellable(backoff, opts?.signal)
    }
  }
  // Unreachable — the loop either returns or throws.
  throw lastErr
}

export type LitellmCreateNonStreamParams = Omit<
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  'metadata'
> & {
  metadata?: { tags: string[] }
}

export type LitellmCreateStreamParams = Omit<
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
  'metadata'
> & {
  metadata?: { tags: string[] }
}

/**
 * Non-streaming chat completion through LiteLLM. Use when you need the
 * full response in one shot — e.g. `web_search` / `fetch_url` synthesis,
 * voice transcribe, voice-tick billing.
 */
export async function litellmCompletion(
  client: OpenAI,
  body: LitellmCreateNonStreamParams,
  opts?: { signal?: AbortSignal }
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  return withRetry(
    () => client.chat.completions.create(
      body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      opts
    ),
    opts
  )
}

/**
 * Streaming chat completion through LiteLLM. Use for the agentic loop's
 * main turn-by-turn streaming where we read tool-call deltas as they
 * arrive. Returns an `AsyncIterable<ChatCompletionChunk>` instead of the
 * SDK's `Stream<...>` — the chunk-translator in `messageTranslation.ts`
 * only consumes the iterator interface.
 */
export async function litellmStream(
  client: OpenAI,
  body: LitellmCreateStreamParams,
  opts?: { signal?: AbortSignal }
): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
  // 429 surfaces synchronously from the SDK before the stream starts —
  // retrying here covers the "I never got a single chunk" failure
  // mode. A 429 mid-stream (rare; happens if the proxy bills as you
  // go) would NOT be caught here, but we have no resumption strategy
  // for that anyway and the caller's existing error handler is the
  // right surface.
  return withRetry(
    () => client.chat.completions.create(
      body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      opts
    ),
    opts
  )
}
