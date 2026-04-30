// JWTs minted by the renderer container (`renderer/src/render.ts`) and
// verified by the app on the `/_internal/render/:docId` route. Signed with
// the same `INTERNAL_API_SECRET` already used for sync→app + app→sync
// internal calls — gives us one rotating-secret surface to track.
//
// Scope is `'render'` so a leak of an unrelated `INTERNAL_API_SECRET`-signed
// token (none exist today, but defence in depth) can't pivot to a render
// route. TTL is intentionally short — the renderer always mints fresh per
// request, so a 60 s window is enough for navigation + Hocuspocus sync.

import jwt from 'jsonwebtoken'

export interface RenderTokenPayload {
  docId: string
  snapshotId: number
  scope: 'render'
}

const TOKEN_TTL_SECONDS = 60

export function mintRenderToken(docId: string, snapshotId: number): string {
  const config = useRuntimeConfig()
  if (!config.internalApiSecret) {
    throw new Error('mintRenderToken: internalApiSecret not configured')
  }
  return jwt.sign(
    { docId, snapshotId, scope: 'render' } satisfies RenderTokenPayload,
    config.internalApiSecret,
    { expiresIn: TOKEN_TTL_SECONDS }
  )
}

/**
 * Returns the decoded payload if the token is a valid render-token for
 * `expectedDocId`, otherwise `null`. Catches every verify failure (expired,
 * malformed, scope mismatch, docId mismatch) and collapses them into the
 * same null — the caller responds 403 either way; no need to leak which
 * specific check failed.
 */
export function verifyRenderToken(
  token: string,
  expectedDocId: string
): RenderTokenPayload | null {
  const config = useRuntimeConfig()
  if (!config.internalApiSecret) return null
  const secrets = [config.internalApiSecret, config.internalApiSecretPrevious].filter(Boolean)
  for (const secret of secrets) {
    try {
      const payload = jwt.verify(token, secret as string) as RenderTokenPayload
      if (payload.scope !== 'render') return null
      if (payload.docId !== expectedDocId) return null
      return payload
    } catch {
      // Try next secret in rotation; if all fail we return null below.
    }
  }
  return null
}
