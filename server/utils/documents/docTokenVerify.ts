import type { H3Event } from 'h3'
import { getRequestHeader, getQuery } from 'h3'
import { verifyJwtWithRotation } from '../../../shared/utils/security/secrets'

// Accepts a Y.js connection JWT as an HTTP request parameter and checks
// its `docId` claim against the doc being accessed. This is the only
// path by which an *anonymous* user who verified a document password
// can prove access on a plain HTTP request — the password endpoint
// issues them a scoped JWT with no matching session cookie.
//
// Authenticated users don't need this: file / activity endpoints fall
// back to their session + workspace_members lookup. The JWT path is a
// view-level capability, deliberately not a full session substitute.
//
// Split into three pieces so unit tests can exercise the pure halves
// without building a full H3 event:
//   - `extractToken(event)`   — HTTP-layer parsing only
//   - `verifyDocJwt(...)`     — pure crypto + scope check
//   - `hasValidDocJwt(...)`   — production orchestrator wiring
//                               runtimeConfig into the two halves

/**
 * Look for a Y.js JWT on the request — `Authorization: Bearer …`
 * header preferred, `?token=…` query param as fallback for the
 * 302-redirect HTML-image flow where a custom header isn't possible.
 * Header wins when both are present. Returns null when neither is
 * usable.
 */
export function extractToken(event: H3Event): string | null {
  const auth = getRequestHeader(event, 'authorization')
  if (typeof auth === 'string' && auth.length > 0) {
    // "Bearer" (case-insensitive) + ≥1 whitespace char, then the token.
    // Prefix-test + slice + trim instead of /^Bearer\s+(.+)$/ — the
    // ambiguous \s+/.+ boundary in that regex backtracks super-linearly
    // on attacker-supplied header values. A header that is "Bearer" +
    // whitespace only yields no token and falls through to the query
    // param, same as a bare "Bearer".
    if (/^Bearer\s/i.test(auth)) {
      const token = auth.slice('Bearer'.length).trim()
      if (token.length > 0) return token
    }
  }
  const q = getQuery(event).token
  if (typeof q === 'string' && q.length > 0) return q
  return null
}

/**
 * Scope-narrowed doc JWTs. Session-shaped tokens (Hocuspocus connection,
 * password unlock) carry NO `scope` claim and are accepted everywhere a
 * doc JWT is; a token WITH a scope is only accepted by an endpoint that
 * lists that scope. `file-access` tokens (render page, live preview
 * iframe) therefore unlock `/api/files` only — not the activity log or
 * the metadata endpoint.
 */
export type DocJwtScope = 'file-access'

/**
 * Verify a JWT signature, then confirm its `docId` claim matches the
 * expected doc and its `scope` (if any) is one the caller accepts.
 * Returns true iff all checks pass. Every failure mode (bad signature,
 * expired, malformed, wrong docId, missing docId, foreign scope)
 * collapses to `false` — callers treat "no token" and "bad token"
 * identically and let the session-based path handle it.
 *
 * Pure function: takes only primitives (no H3Event, no runtimeConfig).
 * Pass the current JWT secret + optional previous-secret for rotation.
 */
export function verifyDocJwt(
  token: string,
  expectedDocId: string,
  secret: string,
  previous?: string | null,
  acceptedScopes: readonly DocJwtScope[] = []
): boolean {
  try {
    const payload = verifyJwtWithRotation<{ docId?: unknown, scope?: unknown }>(
      token,
      secret,
      previous || undefined
    )
    if (typeof payload?.docId !== 'string' || payload.docId !== expectedDocId) return false
    if (payload.scope === undefined) return true
    return acceptedScopes.some(scope => scope === payload.scope)
  } catch {
    return false
  }
}

/**
 * Production orchestrator. Pulls secrets from runtimeConfig, extracts
 * the token off the request, delegates to `verifyDocJwt`. Unit tests
 * call the two pure halves directly; this function is exercised by
 * integration tests.
 */
export function hasValidDocJwt(
  event: H3Event,
  expectedDocId: string,
  acceptedScopes: readonly DocJwtScope[] = []
): boolean {
  const token = extractToken(event)
  if (!token) return false

  const config = useRuntimeConfig()
  if (!config.jwtSecret) return false
  return verifyDocJwt(token, expectedDocId, config.jwtSecret, config.jwtSecretPrevious || undefined, acceptedScopes)
}
