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
 * Single-holder semaphore, backed by `SET NX EX` on Valkey. The first
 * caller wins (returns true); subsequent callers see `false` until the
 * holder releases or the TTL expires.
 *
 * Used for the dictation concurrent-session cap: only one WS session
 * per user. An in-memory `Set<userId>` would silently break across
 * multiple Nitro workers / containers (a user's two tabs could land
 * on different processes and both slip through). Valkey gives us a
 * cluster-consistent lock in one network round-trip.
 *
 * TTL is a safety net — if a process crashes without releasing the
 * lock, it self-expires after `ttlMs`. Callers should pass a value
 * ≥ the longest legitimate session length so a live session never
 * loses its lock while still in use.
 *
 * Returns `false` (i.e. "don't proceed") if Valkey is unreachable
 * because this is a CAP not a rate limiter — failing open would let
 * unlimited concurrent sessions through on a Valkey outage. Callers
 * should surface the error; the app already degrades gracefully when
 * dictation is unavailable.
 */
export async function tryAcquireSessionLock(
  namespace: string,
  key: string,
  ttlMs: number
): Promise<boolean> {
  // NOTE: deliberately NO `TEST_MODE === '1'` bypass here, unlike
  // `checkRateLimit` / `consumeRateLimitBudget`. Those are DoS
  // limits where tests would pound the endpoint; a bypass prevents
  // flakiness. This function is a CORRECTNESS lock (one dictation
  // session per user), and tests need to verify concurrent-session
  // rejection. Valkey self-cleans via TTL + explicit
  // `releaseSessionLock` on the server's WS close hook.

  const lockKey = `lock:${namespace}:${key}`
  try {
    const valkey = useValkey()
    const res = await valkey.set(lockKey, '1', 'PX', ttlMs, 'NX')
    return res === 'OK'
  } catch (e) {
    console.warn('[rateLimit] valkey error on session lock, failing closed:', e instanceof Error ? e.message : e)
    Sentry.captureException(e, {
      tags: { component: 'rateLimit', event: 'valkey_unavailable', namespace }
    })
    return false
  }
}

/**
 * Release a session lock acquired via `tryAcquireSessionLock`.
 * Best-effort: if Valkey is unreachable, we rely on TTL expiration.
 */
export async function releaseSessionLock(
  namespace: string,
  key: string
): Promise<void> {
  // Same rationale as `tryAcquireSessionLock` — session locks need to
  // actually release in tests so subsequent tests (or a test that
  // deliberately opens a second session after closing the first)
  // can reacquire the lock.

  const lockKey = `lock:${namespace}:${key}`
  try {
    const valkey = useValkey()
    await valkey.del(lockKey)
  } catch { /* best-effort; TTL will clean up */ }
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

  const bkey = `rlb:${namespace}:${key}`

  try {
    const valkey = useValkey()
    // Peek current spend. We commit the debit in a second step so we
    // can honour "reject if it'd overflow" semantics — an atomic
    // INCRBY would admit the cost first and force us to roll back.
    const currentStr = await valkey.get(bkey)
    const current = currentStr ? Number(currentStr) : 0

    // Cost 0 = peek. Return the actual remaining without touching
    // the bucket. Callers use this at session-open time to decide
    // whether to proceed; a naive "return maxCost" would always let
    // exhausted users open a session and only the first chunk would
    // trip the real debit, which is a bad UX (opens, then closes
    // immediately with `budget-exhausted`).
    if (cost <= 0) {
      return { allowed: true, remaining: Math.max(0, maxCost - current) }
    }

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

/**
 * Reserve one "inflight slot" under a counter. Used to prevent
 * concurrent-request races from overshooting caps BEFORE a DB write
 * commits — e.g. 500 simultaneous knowledge upload-requests all read
 * count=499 from the DB and all pass the per-workspace cap check.
 *
 * Returns `{ allowed, current }`. When `allowed=false`, no slot was
 * reserved; caller should 409. `current` is post-increment on success.
 *
 * TTL is a safety net — the counter is decremented on confirm / abort,
 * but if the caller crashes between `reserve` and `release` the TTL
 * lets the slot self-free. Keep `ttlMs` close to the presigned-URL TTL
 * (plus a margin) so abandoned presigns don't pin slots forever.
 *
 * Fails CLOSED on Valkey error — inflight tracking is a correctness
 * cap, not a rate limit. Failing open would re-open the race.
 */
export async function reserveInflightSlot(
  namespace: string,
  key: string,
  maxSlots: number,
  ttlMs: number
): Promise<{ allowed: boolean, current: number }> {
  if (process.env.TEST_MODE === '1') return { allowed: true, current: 0 }

  const ckey = `inflight:${namespace}:${key}`
  try {
    const valkey = useValkey()
    const current = Number(await valkey.get(ckey) ?? 0)
    if (current >= maxSlots) return { allowed: false, current }
    const after = await valkey.incr(ckey)
    // INCR on a missing key creates it with no TTL; set TTL every time
    // so the worst-case stale counter self-cleans within `ttlMs`.
    await valkey.pexpire(ckey, ttlMs)
    return { allowed: true, current: after }
  } catch (e) {
    console.warn('[rateLimit] valkey error on inflight reserve, failing closed:', e instanceof Error ? e.message : e)
    Sentry.captureException(e, {
      tags: { component: 'rateLimit', event: 'valkey_unavailable', namespace }
    })
    return { allowed: false, current: 0 }
  }
}

/**
 * Decrement an inflight counter. Best-effort — if the decrement fails
 * or the key is missing, TTL will eventually clean up. Never goes
 * negative (Valkey `DECR` can; we clamp by deleting at zero).
 */
export async function releaseInflightSlot(namespace: string, key: string): Promise<void> {
  if (process.env.TEST_MODE === '1') return
  const ckey = `inflight:${namespace}:${key}`
  try {
    const valkey = useValkey()
    const after = await valkey.decr(ckey)
    if (after <= 0) await valkey.del(ckey)
  } catch { /* TTL will clean up */ }
}
