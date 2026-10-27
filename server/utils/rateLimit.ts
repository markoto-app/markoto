import { randomBytes } from 'node:crypto'
import * as Sentry from '@sentry/nuxt'
import { useValkey } from './valkey'
import { isRateLimitBypassed } from '../../shared/utils/testMode'

// Sliding-window-log rate limiter backed by Valkey sorted sets.
//
// Key shape:   rl:{namespace}:{key}
// Members:     `{timestamp}:{random}` — random suffix prevents ZADD dedupe
//              when two calls land in the same millisecond.
// TTL:         2× window (via PEXPIRE), so abandoned keys self-clean.
//
// Check-and-record runs as ONE Lua script (trim → count → add only when
// under the limit), so it is atomic inside Valkey: a burst of N parallel
// requests admits exactly `maxAttempts`. A count-then-add in two round
// trips let every request that read the count before the first write
// through — an unbounded overshoot under concurrency.
//
// Fails open: if Valkey is unreachable, the request is allowed through.
// Rate limits are defense-in-depth (backend still validates payload size,
// auth, etc.) — a wedged Valkey shouldn't DoS the app.

const SLIDING_WINDOW_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1
`

// Count without recording — "has this key already used up its budget?"
// for budgets that only count some outcomes (failed password attempts).
const SLIDING_WINDOW_COUNT_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
return redis.call('ZCARD', KEYS[1])
`

const RECORD_EVENT_SCRIPT = `
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`

// Cost budget: debit only when the new total fits (cost 0 = peek).
// Returns { allowed (1/0), total after the call }.
const BUDGET_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local cost = tonumber(ARGV[1])
if cost <= 0 then
  return {1, current}
end
if current + cost > tonumber(ARGV[2]) then
  return {0, current}
end
local after = redis.call('INCRBY', KEYS[1], cost)
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return {1, after}
`

// Inflight counter: increment only when below the cap.
// Returns { allowed (1/0), counter value }.
const INFLIGHT_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current >= tonumber(ARGV[1]) then
  return {0, current}
end
local after = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return {1, after}
`

function reportValkeyError(e: unknown, namespace: string, what: string): void {
  console.warn(`[rateLimit] valkey error ${what}:`, e instanceof Error ? e.message : e)
  // Surface to the telemetry sink with a stable tag so operators can
  // dashboard "rate-limit protection is currently bypassed" volume.
  Sentry.captureException(e, {
    tags: { component: 'rateLimit', event: 'valkey_unavailable', namespace }
  })
}

function windowMember(now: number): string {
  return `${now}:${randomBytes(6).toString('hex')}`
}

/** Read a `{flag, value}` pair returned by the budget / inflight scripts. */
function readPair(result: unknown): { ok: boolean, value: number } {
  if (!Array.isArray(result)) throw new Error('unexpected script result')
  return { ok: Number(result[0]) === 1, value: Number(result[1] ?? 0) }
}

export async function checkRateLimit(
  namespace: string,
  key: string,
  maxAttempts: number,
  windowMs: number
): Promise<boolean> {
  // Test-mode bypass. The integration suite pounds endpoints far harder
  // than a real user ever would; without this, password-brute-force and
  // doc-delete limits make the suite flaky and order-dependent. Limiter
  // behaviour has its own tests (unit + the real-Valkey concurrency test
  // in tests/repos/rateLimitAtomic.test.ts). Only honoured on instances
  // that don't look like a real deployment — see shared/utils/testMode.ts.
  if (isRateLimitBypassed(namespace)) return true

  const zkey = `rl:${namespace}:${key}`
  const now = Date.now()

  try {
    const result = await useValkey().eval(
      SLIDING_WINDOW_SCRIPT,
      1,
      zkey,
      now,
      now - windowMs,
      maxAttempts,
      windowMember(now),
      windowMs * 2
    )
    return Number(result) === 1
  } catch (e) {
    reportValkeyError(e, namespace, 'failing open')
    return true
  }
}

/**
 * True when `key` already has `maxEvents` or more events in the window.
 * Records nothing — pair with `recordRateLimitEvent` for budgets that
 * only count some outcomes (e.g. failed password attempts). Fails open
 * (false) on Valkey errors and under the test-mode bypass.
 */
export async function isRateLimitExhausted(
  namespace: string,
  key: string,
  maxEvents: number,
  windowMs: number
): Promise<boolean> {
  if (isRateLimitBypassed(namespace)) return false
  const zkey = `rl:${namespace}:${key}`
  try {
    const count = await useValkey().eval(SLIDING_WINDOW_COUNT_SCRIPT, 1, zkey, Date.now() - windowMs)
    return Number(count) >= maxEvents
  } catch (e) {
    reportValkeyError(e, namespace, 'failing open')
    return false
  }
}

/** Record one event in the window read by `isRateLimitExhausted`. Best-effort. */
export async function recordRateLimitEvent(
  namespace: string,
  key: string,
  windowMs: number
): Promise<void> {
  if (isRateLimitBypassed(namespace)) return
  const zkey = `rl:${namespace}:${key}`
  const now = Date.now()
  try {
    await useValkey().eval(RECORD_EVENT_SCRIPT, 1, zkey, now, windowMember(now), windowMs * 2)
  } catch (e) {
    reportValkeyError(e, namespace, 'recording event')
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
  // NOTE: deliberately NO test-mode bypass here, unlike
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
    reportValkeyError(e, namespace, 'on session lock, failing closed')
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
 *   - Cost 0 = peek: returns the actual remaining without touching the
 *     bucket (callers use it at session-open time to decide whether to
 *     proceed at all).
 *
 * The read-check-debit runs as one Lua script, so concurrent debits
 * can't jointly overshoot `maxCost`. The TTL is refreshed on every
 * debit (sliding-window semantics) so an abandoned window self-cleans.
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
  if (isRateLimitBypassed(namespace)) return { allowed: true, remaining: maxCost }

  const bkey = `rlb:${namespace}:${key}`

  try {
    const { ok, value } = readPair(await useValkey().eval(BUDGET_SCRIPT, 1, bkey, cost, maxCost, windowMs))
    return { allowed: ok, remaining: Math.max(0, maxCost - value) }
  } catch (e) {
    reportValkeyError(e, namespace, 'on budget debit, failing open')
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
 * The check-and-increment is one Lua script, so the cap holds under
 * concurrency.
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
  if (isRateLimitBypassed(namespace)) return { allowed: true, current: 0 }

  const ckey = `inflight:${namespace}:${key}`
  try {
    const { ok, value } = readPair(await useValkey().eval(INFLIGHT_SCRIPT, 1, ckey, maxSlots, ttlMs))
    return { allowed: ok, current: value }
  } catch (e) {
    reportValkeyError(e, namespace, 'on inflight reserve, failing closed')
    return { allowed: false, current: 0 }
  }
}

/**
 * Decrement an inflight counter. Best-effort — if the decrement fails
 * or the key is missing, TTL will eventually clean up. Never goes
 * negative (Valkey `DECR` can; we clamp by deleting at zero).
 */
export async function releaseInflightSlot(namespace: string, key: string): Promise<void> {
  if (isRateLimitBypassed(namespace)) return
  const ckey = `inflight:${namespace}:${key}`
  try {
    const valkey = useValkey()
    const after = await valkey.decr(ckey)
    if (after <= 0) await valkey.del(ckey)
  } catch { /* TTL will clean up */ }
}
