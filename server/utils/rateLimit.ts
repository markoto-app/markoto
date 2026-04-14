import { randomBytes } from 'node:crypto'
import * as Sentry from '@sentry/nuxt'
import { useValkey } from './valkey'

// Sliding-window-log rate limiter backed by Valkey sorted sets.
//
// Key shape:   rl:{namespace}:{key}
// Members:     `{timestamp}:{random}` — random suffix prevents ZADD dedupe
//              when two calls land in the same millisecond.
// TTL:         2× window (via PEXPIRE), so abandoned keys self-clean.
//
// Two-step (count → add) is NOT atomic, but for our scale the race tolerance
// is trivial: two concurrent requests at count = max-1 can both succeed,
// admitting one extra attempt per burst. Protecting against that needs a
// Lua script and the friction isn't worth it for rate limits.
//
// Fails open: if Valkey is unreachable, the request is allowed through.
// Rate limits are defense-in-depth (backend still validates payload size,
// auth, etc.) — a wedged Valkey shouldn't DoS the app.

export async function checkRateLimit(
  namespace: string,
  key: string,
  maxAttempts: number,
  windowMs: number
): Promise<boolean> {
  const zkey = `rl:${namespace}:${key}`
  const now = Date.now()
  const windowStart = now - windowMs

  try {
    const valkey = useValkey()

    // Drop expired entries, then count — pipelined so it's one RTT.
    const pipeline = valkey.multi()
    pipeline.zremrangebyscore(zkey, '-inf', windowStart)
    pipeline.zcard(zkey)
    const results = await pipeline.exec()
    if (!results) return true   // exec returned null (transaction discarded)

    const count = (results[1]?.[1] as number) ?? 0

    if (count >= maxAttempts) return false

    // Under limit — record and refresh the TTL in one pipeline.
    const member = `${now}:${randomBytes(6).toString('hex')}`
    await valkey.multi()
      .zadd(zkey, now, member)
      .pexpire(zkey, windowMs * 2)
      .exec()

    return true
  } catch (e: any) {
    console.warn('[rateLimit] valkey error, failing open:', e?.message || e)
    // Surface to the telemetry sink with a stable tag so operators can
    // dashboard "rate-limit protection is currently bypassed" volume.
    Sentry.captureException(e, {
      tags: { component: 'rateLimit', event: 'valkey_unavailable', namespace }
    })
    return true
  }
}
