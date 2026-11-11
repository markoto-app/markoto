import { resolveDocBrand } from '../../utils/brandKit/docBrand'
import { listBrandAssets } from '../../repos/brandAssets'
import { applyBrandLock } from '~~/shared/utils/brandLock'
import { mintFileAccessToken } from '../../utils/storage/fileAccessToken'
import { verifyRenderToken } from '../../utils/rendering/renderTokens'
import { getDoc } from '../../repos/documents'
import { reconstructDocAtYjsId } from '../../utils/documents/historyReplay'
import { resolveDocProperties } from '../../utils/documents/docProperties'
import { listConfirmedUploadsForDoc } from '../../repos/uploads'
import { planHasFeature, resolveDocPlanFor } from '../../utils/billing/entitlements'
import { DESIGN_SAMPLE_ID_RE, loadDesignSample } from '../../utils/designImport/sampleRender'
import { customCssForPlan } from '~~/shared/utils/themePresets'

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

  // "Create a design from a document": a sample document rendered in a
  // proposed theme. Not a stored document — its content sits in Valkey
  // for the render's duration (utils/designImport/sampleRender.ts). Same
  // render-token check as above; no uploads, so no usable file token.
  if (DESIGN_SAMPLE_ID_RE.test(docId)) {
    const sample = await loadDesignSample(docId)
    if (!sample) throw createError({ statusCode: 404, message: 'Sample not found' })
    return {
      snapshotId: payload.snapshotId,
      markdown: sample.markdown,
      theme: sample.theme,
      title: sample.title,
      description: '',
      audience: 'business',
      language: sample.language,
      fileAccessToken: '',
      fileIds: [],
      brandFonts: [],
      brandFiles: [],
      appOrigins: customCssAppOrigins()
    }
  }

  // Verify the doc actually exists. The renderer may pass a stale docId
  // if the doc was deleted between snapshot and render — better to 404
  // here than to issue against a nonexistent doc.
  const doc = await getDoc(docId)
  if (!doc) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  // Materialize the doc by replaying every yjs_documents row up to the
  // snapshot. `null` (no rows yet) yields an empty doc — paged.js
  // paginates a blank doc to zero pages, which the renderer surfaces as
  // an error.
  //
  // Theme + properties come from the replayed ymeta first, the row only
  // as a fallback: only the OWNER's editor persists them to the row, so
  // an anonymous doc's theme (and any change by a workspace editor or an
  // open-edit visitor) lives in Y.js alone. Reading `doc.theme` here
  // rendered those PDFs with the default theme.
  const snapshotId = payload.snapshotId > 0 ? payload.snapshotId : null
  const ydoc = await reconstructDocAtYjsId(docId, snapshotId)
  let markdown: string
  let properties: ReturnType<typeof resolveDocProperties>
  try {
    markdown = ydoc.getText('content').toJSON()
    properties = resolveDocProperties(ydoc.getMap('meta'), doc)
  } finally {
    ydoc.destroy()
  }

  // Mint a short-lived, read-only doc-scoped `file-access` JWT so the
  // print page can load `/api/files/{docId}/...` images on PRIVATE /
  // password-protected / workspace docs. Without this, decideFileAccess
  // denies the renderer's anonymous fetch (it has no session cookie) and
  // the images come up blank in the PDF. The print page appends it to the
  // document's own upload URLs (`fileIds` below) before paginating. Only
  // /api/files accepts the `file-access` scope (and Hocuspocus refuses any
  // scoped token); 5-minute TTL is well longer than any single render but
  // short enough to be useless if it leaks. See server/utils/storage/fileAccessToken.ts.
  const fileAccessToken = mintFileAccessToken(docId, 5 * 60).token

  // Plan gate (authoritative): custom CSS reaches the PDF only when the
  // document's plan includes it. Y.js writes bypass the API's write-time
  // check, so the render path decides. The stored CSS stays untouched.
  // A built-in preset's template CSS is not gated (customCssForPlan).
  //
  // Brand kit (WP10): a locked workspace design replaces everything but the
  // document's cover text (shared/utils/brandLock.ts) — before the CSS
  // gate, which then judges the workspace design's CSS like any other.
  const brand = await resolveDocBrand(doc.workspaceId)
  const ownTheme = brand.lockedTheme ? applyBrandLock(properties.theme, brand.lockedTheme) : properties.theme
  const customCssAllowed = planHasFeature(await resolveDocPlanFor(doc), 'customCss')
  const css = customCssForPlan(ownTheme?.customCss, customCssAllowed)
  const theme = !ownTheme || css === ownTheme.customCss
    ? ownTheme
    : { ...ownTheme, customCss: css }

  return {
    snapshotId: payload.snapshotId,
    markdown,
    theme,
    title: properties.title,
    description: properties.description,
    audience: properties.audience,
    language: properties.language,
    fileAccessToken,
    // The document's confirmed uploads. The print page gives the token
    // ONLY to `/api/files/<docId>/<fileId>` URLs naming one of these
    // (app/utils/renderFileTokens.ts), never to arbitrary URLs in the
    // content.
    fileIds: (await listConfirmedUploadsForDoc(docId)).map(u => u.fileId),
    // Workspace brand kit (WP10): the fonts to declare, and the brand-kit
    // files (fonts + logos) the token may go to — `/api/brand/<file>`
    // URLs in the theme load through `/api/docs/<docId>/brand/<file>`.
    brandFonts: brand.fonts,
    brandFiles: doc.workspaceId ? (await listBrandAssets(doc.workspaceId)).map(a => `${a.id}.${a.format}`) : [],
    // Public app origin(s) — absolute `https://<app>/api/files/…` URLs in
    // custom CSS are treated as this app's (the print page itself is
    // served from the internal container origin, so it can't tell).
    appOrigins: customCssAppOrigins()
  }
})
