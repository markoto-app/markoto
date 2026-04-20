import type { H3Event } from 'h3'
import { verifyJwtWithRotation } from '../../shared/utils/secrets'

// Accepts a Y.js connection JWT as an HTTP request parameter and checks
// its `docId` claim against the doc being accessed. This is the only path
// by which an *anonymous* user who verified a document password can prove
// access on a plain HTTP request — the password endpoint issues them a
// scoped JWT with no matching session cookie.
//
// Authenticated users don't need this: file / activity endpoints fall
// back to their session + workspace_members lookup. The JWT path is a
// view-level capability, deliberately not a full session substitute.

/**
 * Look for a Y.js JWT on the request (`?token=...` query or
 * `Authorization: Bearer …` header) and return true iff it verifies and
 * its `docId` claim matches `expectedDocId`. All failure modes collapse
 * to `false` — callers treat "no token" and "bad token" identically and
 * let the session-based path handle it.
 *
 * Header is checked first so that programmatic clients (curl, scripts)
 * can use the standard bearer form; query-param is for the 302-redirect
 * HTML-image flow where adding a header isn't possible.
 */
export function hasValidDocJwt(event: H3Event, expectedDocId: string): boolean {
  const token = extractToken(event)
  if (!token) return false

  const config = useRuntimeConfig()
  if (!config.jwtSecret) return false
  const previous = config.jwtSecretPrevious || undefined

  try {
    const payload = verifyJwtWithRotation<{ docId?: unknown }>(
      token,
      config.jwtSecret,
      previous
    )
    return typeof payload?.docId === 'string' && payload.docId === expectedDocId
  } catch {
    return false
  }
}

function extractToken(event: H3Event): string | null {
  const auth = getRequestHeader(event, 'authorization')
  if (typeof auth === 'string' && auth.length > 0) {
    const match = auth.match(/^Bearer\s+(.+)$/i)
    if (match && match[1]) return match[1].trim()
  }
  const q = getQuery(event).token
  if (typeof q === 'string' && q.length > 0) return q
  return null
}
