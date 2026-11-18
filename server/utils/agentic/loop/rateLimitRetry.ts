import { rateLimitRetryAfterMs, sleepCancellable } from '../../litellm/createCompletion'

// Opening a turn's stream that LiteLLM answers with 429 (after its own
// retry and the deployment's fallback) is retried here with a backoff:
// the wait the upstream asked for (`Retry-After`), else 2 s / 5 s / 10 s,
// at most 3 retries, and only while the wait still ends before the
// session's closing margin. This is the loop's only 429 retry: the stream
// is opened with `litellmStream(..., { callerRetries: true })`, so neither
// the wrapper's 4-step backoff nor the SDK's own retries stack on top.
// Distinct from `streamTurn`'s transport retry (one retry of a stream that
// failed with a 5xx / connection error), which never retries a 429.

/** Waits before retry 1, 2, 3 when the 429 named no `Retry-After`. */
const RATE_LIMIT_BACKOFF_MS: readonly number[] = [2_000, 5_000, 10_000]
/** A `Retry-After` longer than this is cut to it (the session has minutes, not hours). */
export const MAX_RETRY_AFTER_MS = 30_000

export interface RateLimitRetryOptions {
  signal: AbortSignal
  /** The session's hard deadline (ms epoch); undefined = none. */
  deadlineAt?: number
  /** Time kept free before the deadline for the closing turn. */
  reserveMs: number
  now?: () => number
  log: (msg: string) => void
  /** Errors never retried even with status 429 (budget refusals: a correctness signal, not a throttle). */
  isFinal?: (e: unknown) => boolean
  /** Test seam; defaults to an abortable timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Run `open`, retrying it on 429 as described above. Any other error, and the last 429, propagates. */
export async function withRateLimitRetry<T>(open: () => Promise<T>, opts: RateLimitRetryOptions): Promise<T> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? sleepCancellable
  for (let retry = 0; ; retry++) {
    try {
      return await open()
    } catch (e) {
      const hint = rateLimitRetryAfterMs(e)
      const backoff = RATE_LIMIT_BACKOFF_MS[retry]
      if (hint === null || backoff === undefined || opts.signal.aborted || opts.isFinal?.(e)) throw e
      const wait = hint > 0 ? Math.min(hint, MAX_RETRY_AFTER_MS) : backoff
      if (opts.deadlineAt !== undefined && now() + wait > opts.deadlineAt - opts.reserveMs) throw e
      opts.log(`rate limited (429) opening the turn; retry ${retry + 1} of ${RATE_LIMIT_BACKOFF_MS.length} in ${wait} ms`)
      await sleep(wait, opts.signal)
    }
  }
}
