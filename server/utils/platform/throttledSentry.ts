import * as Sentry from '@sentry/nuxt'

// Fire-and-forget paths (sync-server notify, internal HTTP) must not
// flood Sentry when a misconfigured URL fails every single request.
// `captureExceptionThrottled(key, ...)` forwards the first occurrence
// in each TTL window to Sentry and suppresses the rest — so a broken
// `NUXT_SYNC_INTERNAL_URL` in prod surfaces once, not per-request.
//
// The console.warn logs still fire per-occurrence so tail-the-logs
// debugging stays intact.

const DEFAULT_TTL_MS = 5 * 60 * 1000

const lastFired = new Map<string, number>()

export function captureExceptionThrottled(
  key: string,
  error: unknown,
  options: Parameters<typeof Sentry.captureException>[1] = {},
  ttlMs: number = DEFAULT_TTL_MS
): void {
  const now = Date.now()
  const last = lastFired.get(key) ?? 0
  if (now - last < ttlMs) return
  lastFired.set(key, now)
  Sentry.captureException(error, options)
}
