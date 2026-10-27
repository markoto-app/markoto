import { mintFileAccessToken } from '../../utils/fileAccessToken'
import { verifyRenderToken } from '../../utils/renderTokens'
import { getDoc } from '../../repos/documents'
import { reconstructTextAtYjsId } from '../../utils/historyReplay'

// Called from the internal print page (`app/pages/_internal/render/[docId].vue`)
// during SSR. Validates the render-token, replays the doc's Y.js history to
// materialize the current markdown body, returns everything the print page
// needs to run paged.js. The page does NOT connect to Hocuspocus — Y.Doc
// state is server-rendered here and shipped down as a string.
//
// Why server-replay instead of having the page connect to Hocuspocus:
//   - One fewer moving part. The print page is single-purpose and short-
//     lived; spinning up a WebSocket just to read content the server already
//     has is wasted latency (1–2s per render).
//   - Tests can run without a live sync server. Integration tests boot a
//     real renderer container against a real Nuxt subprocess and a real
//     pg-stored Y.Doc — no Hocuspocus container needed for the integration
//     suite, only the flow suite.
//   - At-most-flushSize-stale is fine for renders. The Hocuspocus default
//     of `flushSize: 200` means recent edits land in y-postgresql within a
//     few seconds. PDF / page-screenshot consumers (download, AI tools)
//     are not real-time-collaboration surfaces, so a couple-second lag on
//     an in-progress edit is invisible.

export default defineEventHandler(async (event) => {
  const docId = getQuery(event).docId as string | undefined
  const token = getQuery(event).t as string | undefined

  if (typeof docId !== 'string' || !docId || typeof token !== 'string' || !token) {
    throw createError({ statusCode: 400, message: 'Missing docId or t' })
  }

  const payload = verifyRenderToken(token, docId)
  if (!payload) {
    throw createError({ statusCode: 403, message: 'Invalid render token' })
  }

  // Verify the doc actually exists. The renderer may pass a stale docId
  // if the doc was deleted between snapshot and render — better to 404
  // here than to issue against a nonexistent doc.
  const doc = await getDoc(docId)
  if (!doc) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  // Materialize the current ytext by replaying every yjs_documents row.
  // `null` (no rows yet) yields an empty string — paged.js paginates a
  // blank doc to zero pages, which the renderer surfaces as an error.
  const snapshotId = payload.snapshotId > 0 ? payload.snapshotId : null
  const markdown = await reconstructTextAtYjsId(docId, snapshotId)

  // Mint a short-lived, read-only doc-scoped `file-access` JWT so the
  // print page can load `/api/files/{docId}/...` images on PRIVATE /
  // password-protected / workspace docs. Without this, decideFileAccess
  // denies the renderer's anonymous fetch (it has no session cookie) and
  // the images come up blank in the PDF. The print page appends it to
  // every /api/files URL before paginating. Only /api/files accepts the
  // `file-access` scope (and Hocuspocus refuses any scoped token); 5-minute
  // TTL is well longer than any single render but short enough to be
  // useless if it leaks. See server/utils/fileAccessToken.ts.
  const fileAccessToken = mintFileAccessToken(docId, 5 * 60).token

  return {
    snapshotId: payload.snapshotId,
    markdown,
    theme: doc.theme,
    title: doc.title,
    description: doc.description,
    audience: doc.audience,
    language: doc.language,
    fileAccessToken,
    // Public app origin(s) — absolute `https://<app>/api/files/…` URLs in
    // custom CSS are treated as this app's (the print page itself is
    // served from the internal container origin, so it can't tell).
    appOrigins: customCssAppOrigins()
  }
})
