import { getDocWithActorRole } from '../../../repos/documents'
import { docStateOf, decideFileAccess, type DocState, type ActorState } from '../../../../shared/utils/documents/docPermissions'
import { hasValidDocJwt } from '../../../utils/documents/docTokenVerify'
import { mintFileAccessToken } from '../../../utils/storage/fileAccessToken'

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
// the document's images may get the token. Public route (whitelisted in
// middleware/auth.ts) because anonymous password-holders need it too.

/** 15 minutes: the editor refreshes it before it expires. */
const FILE_TOKEN_TTL_SECONDS = 15 * 60

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)

  if (!(await checkRateLimit('file-token', getClientRateLimitKey(event), 60, 60_000))) {
    throw createError({ statusCode: 429, message: 'Too many requests. Try again in a minute.' })
  }

  const session = await getValidatedUserSession(event)
  const row = await getDocWithActorRole(docId, session?.user?.id ?? null)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  const doc: DocState = docStateOf(row)
  const actor: ActorState = {
    userId: session?.user?.id ?? null,
    workspaceRole: row.workspaceRole,
    // Session-shaped doc JWT only (password unlock / Hocuspocus token): a
    // file-access token must not be able to mint its own successor.
    hasValidDocJwt: hasValidDocJwt(event, docId)
  }
  if (decideFileAccess(doc, actor).outcome === 'deny') {
    throw createError({ statusCode: 403, message: 'Access denied' })
  }

  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  return mintFileAccessToken(docId, FILE_TOKEN_TTL_SECONDS)
})
