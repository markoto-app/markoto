import { mintFileAccessToken } from '../../../utils/storage/fileAccessToken'
import { MINUTE_MS } from '~~/shared/config/units'

// GET /api/docs/:docId/file-token — short-lived `file-access` JWT for the
// live preview and browser print iframes.
//
// Both iframes run sandboxed WITHOUT `allow-same-origin` (opaque origin), so
// their `<img src="/api/files/…">` requests are cross-site and carry no
// session cookie. The editor fetches this token (with its cookie, or with
// the password-unlock doc JWT as Bearer) and appends it as `?token=` to the
// document's own image URLs before handing the HTML to the iframe — the
// same mechanism the server render page uses.
//
// Same access decision as /api/files (`decideFileAccess`): whoever may read
// the document's images may get the token. Public route (on the allowlist)
// because anonymous password-holders need it too. Session-shaped doc JWTs
// only (password unlock / Hocuspocus token): a file-access token must not be
// able to mint its own successor.

/** 15 minutes: the editor refreshes it before it expires. */
const FILE_TOKEN_TTL_SECONDS = 15 * 60

export default defineApiHandler({
  access: allow.doc('file', { anonymous: true, jwt: true, deny: 'files/access-denied' }),
  rateLimit: { namespace: 'file-token', max: 60, windowMs: MINUTE_MS, key: 'ip' },
  handler: async ({ event, docId }) => {
    setResponseHeader(event, 'Cache-Control', 'private, no-store')
    return mintFileAccessToken(docId, FILE_TOKEN_TTL_SECONDS)
  }
})
