import type { H3Event } from 'h3'
import { useValkey } from './valkey'

/**
 * Stripe-style idempotency for unsafe POST endpoints.
 *
 * Without an `Idempotency-Key` header this just calls `fn`. With one, the key
 * is scoped to (scope, userId, key) so users and endpoints can't collide.
 *
 * The first request claims the key in Valkey (`SET NX EX`) with a `pending:`
 * placeholder, runs `fn`, then overwrites it with `{ kind: 'result', value }`.
 * The placeholder TTL is also the in-flight upper bound: after a crash it
 * expires and a retry can claim the key. A repeat request that sees
 * `pending:` gets 409 (fail fast, so a stuck producer can't pin requests);
 * one that sees an envelope gets the cached result.
 *
 * Errors are not cached: if `fn` throws the placeholder is deleted so a retry
 * can re-run immediately.
 *
 * The 5 minute TTL covers a slow Y.js clone + S3 copy without blocking a
 * legitimate retry later. Valkey rather than Postgres because this is request
 * de-duplication, not billing correctness, and `SET NX` is one atomic call.
 */

const PENDING_SENTINEL = 'pending:'
const DEFAULT_RESULT_TTL_SECONDS = 5 * 60

interface CachedEnvelope<T> {
  kind: 'result'
  value: T
}

export async function withIdempotency<T>(
  event: H3Event,
  scope: string,
  userId: number,
  fn: () => Promise<T>
): Promise<T> {
  const key = getRequestHeader(event, 'idempotency-key')?.trim()
  if (!key) return fn()

  // Short keys would work but make client bugs (a hard-coded 'x') hard to
  // diagnose. 16-256 covers UUIDs, ULIDs and nanoids.
  if (key.length < 16 || key.length > 256) {
    throw createError({
      statusCode: 400,
      message: 'Idempotency-Key must be 16–256 characters'
    })
  }

  const valkey = useValkey()
  const valkeyKey = `idempotent:${scope}:${userId}:${key}`

  // SET NX EX returns 'OK' on success, null when the key exists.
  const claimed = await valkey.set(valkeyKey, PENDING_SENTINEL, 'EX', DEFAULT_RESULT_TTL_SECONDS, 'NX')

  if (claimed !== 'OK') {
    const existing = await valkey.get(valkeyKey)
    if (existing === null) {
      // The key expired between SET NX and GET. Re-run without the cache
      // rather than recursing; one extra execution at a TTL boundary is fine.
      return fn()
    }
    if (existing === PENDING_SENTINEL) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Conflict',
        message: 'A request with this Idempotency-Key is already in flight; retry shortly.',
        data: { retryAfterSeconds: 5 }
      })
    }
    try {
      const parsed = JSON.parse(existing) as CachedEnvelope<T>
      if (parsed?.kind === 'result') {
        return parsed.value
      }
      // Corrupt envelope: drop and re-run rather than serve garbage.
    } catch {
      // Malformed entry: same.
    }
    await valkey.del(valkeyKey)
    return fn()
  }

  try {
    const result = await fn()
    const envelope: CachedEnvelope<T> = { kind: 'result', value: result }
    // Plain SET overwrites the placeholder and restarts the TTL from completion.
    await valkey.set(valkeyKey, JSON.stringify(envelope), 'EX', DEFAULT_RESULT_TTL_SECONDS)
    return result
  } catch (err) {
    // Best effort: if Valkey is unreachable the placeholder expires on its own.
    try {
      await valkey.del(valkeyKey)
    } catch { /* ignore */ }
    throw err
  }
}
