import * as Sentry from '@sentry/nuxt'
import { MINUTE_MS } from '~~/shared/config/units'

// Fire-and-forget paths (sync-server notify, internal HTTP) must not flood
// Sentry when a misconfigured URL fails every request.
// `captureExceptionThrottled(key, ...)` forwards the first occurrence per TTL
// window and suppresses the rest. Callers' own log lines still fire each time.

const DEFAULT_TTL_MS = 5 * MINUTE_MS

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
