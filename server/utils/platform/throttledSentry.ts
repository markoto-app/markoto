import * as Sentry from '@sentry/nuxt'

// Fire-and-forget paths (sync-server notify, internal HTTP) must not flood
// Sentry when a misconfigured URL fails every request.
// `captureExceptionThrottled(key, ...)` forwards the first occurrence per TTL
// window and suppresses the rest. Callers' console.warn logs still fire each time.

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
