import jwt from 'jsonwebtoken'

// Secret rotation helpers: used on both sides of the app/sync boundary,
// hence the `shared/` location (imported via relative paths from both
// `server/` and `sync-server/src/`). Keep the Nitro app and sync-server
// Dockerfiles in step when moving files around here: sync-server's
// Dockerfile builds from the repo root and COPYs `shared/` in.
//
// The plain shared-secret comparison lives in internalSecret.ts
// (dependency-free, so the renderer can carry a copy).
//
// Lets us rotate `JWT_SECRET` and `INTERNAL_API_SECRET` without downtime
// by accepting an optional `_PREVIOUS` value during the rollover window.
// Issuers always use the current secret; verifiers accept either.
//
// Full procedure: see the operator runbook, kept outside this repository.

/**
 * Verify a JWT with the current secret, falling back to the previous
 * secret on signature mismatch. We only swallow `JsonWebTokenError` (the
 * signature-failure path during rotation). Other verify errors, expired,
 * malformed: propagate.
 *
 * `algorithms: ['HS256']` is pinned explicitly. Without it, `jwt.verify`
 * auto-accepts any HMAC variant the token header declares (HS256, HS384,
 * HS512): harmless today given our 64-char shared secret, but defense-
 * in-depth against a future change that (a) introduces an asymmetric
 * signer (RSA / ECDSA) and accidentally reuses the public key as an HS*
 * secret somewhere, or (b) some other path that weakens header parsing.
 * The signer side uses HS256 (jsonwebtoken's default for string secrets),
 * so pinning HS256-only doesn't reject any legitimate token we issue.
 */
const ALLOWED_ALGORITHMS: jwt.Algorithm[] = ['HS256']

export function verifyJwtWithRotation<T = Record<string, unknown>>(
  token: string,
  current: string,
  previous?: string | null
): T {
  const opts: jwt.VerifyOptions = { algorithms: ALLOWED_ALGORITHMS }
  try {
    return jwt.verify(token, current, opts) as T
  } catch (err) {
    if (previous && err instanceof jwt.JsonWebTokenError && !(err instanceof jwt.TokenExpiredError)) {
      return jwt.verify(token, previous, opts) as T
    }
    throw err
  }
}
