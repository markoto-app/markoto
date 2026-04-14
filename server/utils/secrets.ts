import { timingSafeEqual } from 'node:crypto'
import jwt from 'jsonwebtoken'

// Secret rotation helpers — lets us rotate `JWT_SECRET` and
// `INTERNAL_API_SECRET` without downtime by accepting an optional
// `_PREVIOUS` value during the rollover window.
//
// Issuers always use the current secret. Verifiers accept either.
//
// Procedure (see docs/SECRETS-ROTATION.md):
//   1. `*_PREVIOUS = <current>`  → restart — now accepts old tokens.
//   2. `*       = <new>`         → restart — issues new, accepts both.
//   3. Wait longer than the longest JWT TTL (AI sessions 5 min,
//      sync tokens 15 min). Then:
//   4. Unset `*_PREVIOUS`        → restart — back to single-secret mode.

/**
 * Timing-safe equality for user-supplied secrets against current and
 * (optional) previous values. Short-circuits on length mismatch before
 * the Buffer compare, which is benign: length of the *expected* secret
 * never leaks to the caller, only the fact that the provided string
 * didn't match either.
 */
export function matchesCurrentOrPrevious(
  provided: string,
  current: string,
  previous?: string | null
): boolean {
  if (safeEqual(provided, current)) return true
  if (previous && safeEqual(provided, previous)) return true
  return false
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/**
 * Verify a JWT with the current secret, falling back to the previous
 * secret on signature mismatch. Any other verify error (expired, malformed)
 * propagates — we only swallow `JsonWebTokenError`, which is the signature
 * failure path during rotation.
 */
export function verifyJwtWithRotation<T = Record<string, unknown>>(
  token: string,
  current: string,
  previous?: string | null
): T {
  try {
    return jwt.verify(token, current) as T
  } catch (err) {
    if (previous && err instanceof jwt.JsonWebTokenError && !(err instanceof jwt.TokenExpiredError)) {
      return jwt.verify(token, previous) as T
    }
    throw err
  }
}
