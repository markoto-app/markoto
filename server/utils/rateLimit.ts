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
  // Test-mode bypass. The integration suite pounds endpoints far harder
  // than a real user ever would; without this, password-brute-force and
  // doc-delete limits make the suite flaky and order-dependent. Rate-limit
  // behaviour itself has its own targeted tests when needed.
  if (process.env.TEST_MODE === '1') return true

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
    if (!results) return true // exec returned null (transaction discarded)

    const count = (results[1]?.[1] as number) ?? 0

    if (count >= maxAttempts) return false

    // Under limit — record and refresh the TTL in one pipeline.
    const member = `${now}:${randomBytes(6).toString('hex')}`
    await valkey.multi()
      .zadd(zkey, now, member)
      .pexpire(zkey, windowMs * 2)
      .exec()

    return true
  } catch (e) {
    console.warn('[rateLimit] valkey error, failing open:', e instanceof Error ? e.message : e)
    // Surface to the telemetry sink with a stable tag so operators can
    // dashboard "rate-limit protection is currently bypassed" volume.
    Sentry.captureException(e, {
      tags: { component: 'rateLimit', event: 'valkey_unavailable', namespace }
    })
    return true
  }
}

/**
 * Cost-based sliding window, backed by a plain Valkey counter with a
 * windowed TTL. Unlike `checkRateLimit` (which counts DISCRETE
 * attempts), this bucket sums arbitrary integer costs — the intended
 * use case is billing audio-seconds for live dictation, where a single
 * "attempt" doesn't map cleanly to a request.
 *
 * Contract:
 *   - Returns `{ allowed: true, remaining }` and debits `cost` if the
 *     new total fits within `maxCost` for the window.
 *   - Returns `{ allowed: false, remaining }` WITHOUT debiting if the
 *     request would exceed the cap. Caller should surface a rate-limit
 *     error to the user.
 *
 * Implementation note: we use a single Valkey key per window rather
 * than a sorted set because we don't need per-call provenance — just
 * a running total that expires after `windowMs`. PEXPIRE is set once
 * on first hit and refreshed on every debit so an abandoned window
 * always self-cleans.
 *
 * Fails open (allowed: true, remaining: maxCost) on Valkey errors —
 * same rationale as `checkRateLimit`: rate limits are defense-in-depth,
 * not the primary cost governor. A wedged Valkey shouldn't DoS dictation.
 */
export async function consumeRateLimitBudget(
  namespace: string,
  key: string,
  cost: number,
  maxCost: number,
  windowMs: number
): Promise<{ allowed: boolean, remaining: number }> {
  if (process.env.TEST_MODE === '1') return { allowed: true, remaining: maxCost }
  if (cost <= 0) return { allowed: true, remaining: maxCost }

  const bkey = `rlb:${namespace}:${key}`

  try {
    const valkey = useValkey()
    // Peek current spend. We commit the debit in a second step so we
    // can honour "reject if it'd overflow" semantics — an atomic
    // INCRBY would admit the cost first and force us to roll back.
    const currentStr = await valkey.get(bkey)
    const current = currentStr ? Number(currentStr) : 0
    if (current + cost > maxCost) {
      return { allowed: false, remaining: Math.max(0, maxCost - current) }
    }
    const after = await valkey.incrby(bkey, cost)
    // Refresh the TTL on every write — sliding-window semantics. If
    // the key already had a TTL, PEXPIRE just extends it; if it was
    // first-touch this call (INCRBY creates it with no TTL), we
    // install one here so it always self-cleans.
    await valkey.pexpire(bkey, windowMs)
    return { allowed: true, remaining: Math.max(0, maxCost - after) }
  } catch (e) {
    console.warn('[rateLimit] valkey error on budget debit, failing open:', e instanceof Error ? e.message : e)
    Sentry.captureException(e, {
      tags: { component: 'rateLimit', event: 'valkey_unavailable', namespace }
    })
    return { allowed: true, remaining: maxCost }
  }
}
