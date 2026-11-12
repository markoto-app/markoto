import { randomBytes } from 'node:crypto'
import * as Sentry from '@sentry/nuxt'
import { useValkey } from './valkey'
import { isRateLimitBypassed } from '../../../shared/utils/security/testMode'
import { useLogger } from './logger'

const log = useLogger('rate-limit')

// Sliding-window-log rate limiter backed by Valkey sorted sets.
//
// Key shape:   rl:{namespace}:{key}
// Members:     `{timestamp}:{random}`: random suffix prevents ZADD dedupe
//              when two calls land in the same millisecond.
// TTL:         2× window (via PEXPIRE), so abandoned keys self-clean.
//
// Check-and-record runs as ONE Lua script (trim, count, add only when under
// the limit), so it is atomic inside Valkey: a burst of N parallel requests
// admits exactly `maxAttempts`. Count-then-add in two round trips would let
// every request that read the count before the first write through.
//
// Fails open: if Valkey is unreachable, the request is allowed through.
// Rate limits are defense-in-depth (backend still validates payload size,
// auth, etc.): a wedged Valkey shouldn't DoS the app.

const SLIDING_WINDOW_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1
`

// Count without recording: "has this key already used up its budget?"
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
  log.warn('valkey error', { operation: what, err: e })
  // Stable tag so operators can chart how often rate-limit protection is bypassed.
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
  // The integration suite hits endpoints far harder than a real user, which
  // would make it flaky and order-dependent. Limiter behaviour has its own
  // tests (tests/repos/rateLimitAtomic.test.ts). Only honoured on instances
  // that don't look like a real deployment; see shared/utils/security/testMode.ts.
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
 * Records nothing: pair with `recordRateLimitEvent` for budgets that
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
 * Single-holder semaphore via `SET NX PX` on Valkey: the first caller gets
 * true, others get false until release or TTL expiry.
 *
 * Backs the one-dictation-session-per-user cap. It lives in Valkey because an
 * in-memory set would not hold across Nitro processes.
 *
 * `ttlMs` is only a crash safety net; pass at least the longest legitimate
 * session length so a live session never loses its lock.
 *
 * Fails CLOSED (returns false) when Valkey is unreachable: this is a cap, and
 * failing open would allow unlimited concurrent sessions.
 */
export async function tryAcquireSessionLock(
  namespace: string,
  key: string,
  ttlMs: number
): Promise<boolean> {
  // No test-mode bypass, unlike `checkRateLimit`: this is a correctness lock
  // and tests need to verify concurrent-session rejection.
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
  // No test-mode bypass, same as `tryAcquireSessionLock`: tests must be able to reacquire.
  const lockKey = `lock:${namespace}:${key}`
  try {
    const valkey = useValkey()
    await valkey.del(lockKey)
  } catch { /* best-effort; TTL will clean up */ }
}

/**
 * Cost-based window on a Valkey counter with a windowed TTL. Unlike
 * `checkRateLimit` (discrete attempts) it sums integer costs, e.g. audio
 * seconds for live dictation.
 *
 *   - Debits `cost` and returns `allowed: true` if the new total fits `maxCost`.
 *   - Otherwise returns `allowed: false` without debiting.
 *   - Cost 0 peeks: returns the remaining budget without touching the bucket.
 *
 * Read-check-debit is one Lua script, so concurrent debits can't jointly
 * overshoot. The TTL is refreshed on every debit.
 *
 * Fails open on Valkey errors, like `checkRateLimit`: the real cost governor
 * is the LiteLLM budget.
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
 * Reserve one "inflight slot" under a counter, so concurrent requests can't
 * overshoot a cap before the DB write commits (500 simultaneous upload
 * requests would all read count=499 and pass).
 *
 * Returns `{ allowed, current }`; when `allowed` is false no slot was
 * reserved (caller should 409). Check-and-increment is one Lua script.
 *
 * The counter is decremented on confirm / abort; `ttlMs` frees slots of
 * crashed callers, so keep it near the presigned-URL TTL plus a margin.
 *
 * Fails CLOSED on Valkey errors: this is a correctness cap, and failing open
 * would re-open the race.
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
 * Decrement an inflight counter. Best effort; the TTL cleans up on failure.
 * Deletes the key at zero because `DECR` alone can go negative.
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
