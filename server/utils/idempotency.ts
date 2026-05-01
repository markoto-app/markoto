import type { H3Event } from 'h3'
import { useValkey } from './valkey'

/**
 * Stripe-style idempotency for unsafe POST endpoints.
 *
 * Contract:
 *   - If the request is missing the `Idempotency-Key` header, behave
 *     as if this helper weren't here — just call `fn` and return its
 *     value.
 *   - If the header is present, scope the key to (scope, userId, key)
 *     so two users using the same client-generated UUID don't collide
 *     and so an `Idempotency-Key` reused across endpoints doesn't
 *     short-circuit the wrong handler.
 *   - First request with a given key: claims the key in Valkey via
 *     `SET NX EX resultTtlSeconds` with a `pending:` placeholder, runs
 *     `fn`, then overwrites the key with the JSON-encoded result. The
 *     placeholder TTL doubles as the in-flight upper bound — if `fn`
 *     never finishes (process crash), the placeholder eventually
 *     expires and a retry can claim the key fresh.
 *   - Subsequent request with the same key:
 *       - If the stored value is `pending:`, the duplication is in
 *         flight on another worker — throw 409 "Idempotency key in
 *         use" with a Retry-After hint. v1 chooses fail-fast over
 *         poll-and-wait so a stuck producer can't pin a request.
 *       - If the stored value is a JSON envelope, decode and return
 *         the cached result. The caller emits the same response shape
 *         as the original.
 *   - TTL: 5 minutes by default. Long enough to cover a slow Y.js
 *     clone + S3 copy, short enough to keep the key from blocking a
 *     legitimate retry "the next day".
 *
 * The cached envelope is `{ kind: 'result', value: <fn output> }`.
 * Errors are NOT cached — if `fn` throws, we DELETE the placeholder so
 * a retry can claim a fresh slot. Caching errors would force callers
 * to wait out the TTL on a transient failure.
 *
 * Why Valkey, not Postgres: idempotency is a request-deduplication
 * concern, not a billing-correctness one. Valkey gives us atomic
 * `SET NX` in one round-trip; a Postgres equivalent would need an
 * advisory lock plus a side table plus a TTL sweeper.
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

  // Reject obviously-malformed keys outright. Letting a 4-char or empty
  // key through still works (Valkey doesn't care), but it makes
  // accidental client bugs ("hard-coded 'x'") much harder to diagnose.
  // 16-256 bytes covers UUIDs (36) and most ULIDs/nanoids comfortably.
  if (key.length < 16 || key.length > 256) {
    throw createError({
      statusCode: 400,
      message: 'Idempotency-Key must be 16–256 characters'
    })
  }

  const valkey = useValkey()
  const valkeyKey = `idempotent:${scope}:${userId}:${key}`

  // Try to claim the key. SET NX EX returns 'OK' on success, null
  // when the key already exists.
  const claimed = await valkey.set(valkeyKey, PENDING_SENTINEL, 'EX', DEFAULT_RESULT_TTL_SECONDS, 'NX')

  if (claimed !== 'OK') {
    // Lost the race — read what's there.
    const existing = await valkey.get(valkeyKey)
    if (existing === null) {
      // Race: the key expired between our SET NX and our GET. Re-run
      // fn outside the cache rather than recursing — at most one extra
      // execution per TTL boundary on a corner case is acceptable.
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
    // JSON envelope — decode and replay.
    try {
      const parsed = JSON.parse(existing) as CachedEnvelope<T>
      if (parsed && parsed.kind === 'result') {
        return parsed.value
      }
      // Corrupt envelope: drop and re-run rather than serve garbage.
    } catch {
      // Same: malformed cache entry — drop and re-run.
    }
    await valkey.del(valkeyKey)
    return fn()
  }

  // We claimed the slot. Run the work; on success cache the result, on
  // failure delete the placeholder so a retry can re-attempt.
  try {
    const result = await fn()
    const envelope: CachedEnvelope<T> = { kind: 'result', value: result }
    // Use plain SET (no NX) so we overwrite the placeholder, and
    // refresh the TTL so callers always get the full retention window
    // measured from a successful completion.
    await valkey.set(valkeyKey, JSON.stringify(envelope), 'EX', DEFAULT_RESULT_TTL_SECONDS)
    return result
  } catch (err) {
    // Best-effort placeholder cleanup. If Valkey is unreachable the
    // placeholder will expire on its own; we just don't serve stale
    // 409s in the meantime.
    try {
      await valkey.del(valkeyKey)
    } catch { /* ignore */ }
    throw err
  }
}
