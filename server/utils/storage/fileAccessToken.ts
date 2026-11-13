import jwt from 'jsonwebtoken'
import { useEnv } from '~~/shared/env/load'

// Short-lived, read-only, doc-scoped JWT that unlocks `/api/files/<docId>/…`
// image reads for a browsing context that has no session cookie:
//
//   - the server render page (renderer sidecar's Chromium), minted by
//     `GET /api/_internal/render-bootstrap`;
//   - the live preview + browser print iframes, which run sandboxed with an
//     opaque origin (no `allow-same-origin`), so their image requests are
//     cross-site and carry no cookies. Minted by
//     `GET /api/docs/:docId/file-token` for a caller who may view the files.
//
// The `scope: 'file-access'` claim confines the token: `/api/files` is the
// only endpoint that accepts it (`hasValidDocJwt(…, ['file-access'])`), the
// sync server rejects every scoped token at the WebSocket handshake, and the
// dictate relay requires its own scope. Anyone holding one learns nothing
// beyond the document's own images.

const FILE_ACCESS_SCOPE = 'file-access'

export interface FileAccessToken {
  token: string
  /** Epoch milliseconds. */
  expiresAt: number
}

export function mintFileAccessToken(docId: string, ttlSeconds: number): FileAccessToken {
  const env = useEnv()
  if (!env.auth.jwtSecret) {
    throw createError({ statusCode: 500, message: 'jwtSecret not configured' })
  }
  const token = jwt.sign(
    {
      docId,
      userId: 'file-access',
      userName: null,
      readOnly: true,
      scope: FILE_ACCESS_SCOPE
    },
    env.auth.jwtSecret,
    { expiresIn: ttlSeconds }
  )
  return { token, expiresAt: Date.now() + ttlSeconds * 1000 }
}
