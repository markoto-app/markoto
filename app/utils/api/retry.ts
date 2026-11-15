/**
 * Waits before each retry of a transient failure, in ms. About 45 s in all:
 * long enough for a sidecar that is still starting (LiteLLM after a deploy)
 * to answer.
 */
const TRANSIENT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000] as const

/** A network error or a 5xx: worth asking again. A 4xx is an answer. */
export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  if ((err as { name?: string }).name === 'AbortError') return false
  const status = (err as { statusCode?: number, status?: number }).statusCode ?? (err as { status?: number }).status
  return status === undefined || status >= 500
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Runs `fn` and retries it with backoff while it fails transiently. Inside a
 * query function, so every consumer of the query shares the one retry loop
 * and the query stays pending (not failed) in between.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  { signal, delays = TRANSIENT_RETRY_DELAYS_MS }: { signal?: AbortSignal, delays?: readonly number[] } = {}
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const delay = delays[attempt]
      if (delay === undefined || signal?.aborted || !isTransientError(err)) throw err
      await wait(delay, signal)
    }
  }
}
