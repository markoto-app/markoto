import { timingSafeEqual } from 'node:crypto'
import jwt from 'jsonwebtoken'

// Secret rotation helpers — used on both sides of the app/sync boundary,
// hence the `shared/` location (imported via relative paths from both
// `server/` and `sync-server/src/`). Keep the Nitro app and sync-server
// Dockerfiles in step when moving files around here: sync-server's
// Dockerfile builds from the repo root and COPYs `shared/` in.
//
// Lets us rotate `JWT_SECRET` and `INTERNAL_API_SECRET` without downtime
// by accepting an optional `_PREVIOUS` value during the rollover window.
// Issuers always use the current secret; verifiers accept either.
//
// Full procedure: see docs/SECRETS-ROTATION.md.

/**
 * Timing-safe equality for user-supplied secrets against current and
 * (optional) previous values. Short-circuits on length mismatch — benign:
 * the length of the *expected* secret never leaks to the caller, only the
 * fact that the provided string didn't match either.
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
 * secret on signature mismatch. We only swallow `JsonWebTokenError` (the
 * signature-failure path during rotation). Other verify errors — expired,
 * malformed — propagate.
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
