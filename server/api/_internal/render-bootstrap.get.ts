import { resolveDocBrand } from '../../utils/brandKit/docBrand'
import { listBrandAssetsForDoc } from '../../repos/brandAssets'
import { applyBrandLock } from '~~/shared/utils/theme/brandLock'
import { mintFileAccessToken } from '../../utils/storage/fileAccessToken'
import { getDoc } from '../../repos/documents'
import { reconstructDocAtYjsId } from '../../utils/documents/historyReplay'
import { resolveDocProperties } from '../../utils/documents/docProperties'
import { listConfirmedUploadsForDoc } from '../../repos/uploads'
import { planHasFeature, resolveDocPlanFor } from '../../utils/billing/entitlements'
import { DESIGN_SAMPLE_ID_RE, loadDesignSample } from '../../utils/designImport/sampleRender'
import { customCssForPlan } from '~~/shared/utils/theme/themePresets'
import { renderBootstrapQuery } from '~~/shared/api/platform'

// Called from the internal print page (`app/pages/_internal/render/[docId].vue`)
// during SSR. Validates the render-token, replays the doc's Y.js history to
// materialize the current markdown body, and returns what the print page needs
// to run paged.js. The page does not connect to Hocuspocus: replaying server
// side saves a WebSocket round trip per render and lets integration tests run
// without a sync server. Renders may lag an in-progress edit by the Hocuspocus
// flush interval (a few seconds), which is acceptable for PDF/screenshot use.

export default defineApiHandler({
  // The render token (docId + t from the query) is verified by the policy:
  // 400 on a missing parameter, 403 on any verification failure, with no hint
  // which check failed.
  access: allow.internal('render-token'),
  query: renderBootstrapQuery,
  handler: async ({ query, render: payload, docAccess }) => {
    // The policy always sets it; checked so the handler can't run without a verified token.
    if (!payload) throw apiError('internal/forbidden')
    const docId = query.docId

    // "Create a design from a document": a sample document rendered in a
    // proposed theme. Its content lives in Valkey for the render's duration
    // (utils/designImport/sampleRender.ts). Same render-token check; no uploads,
    // so no file token.
    if (DESIGN_SAMPLE_ID_RE.test(docId)) {
      const sample = await loadDesignSample(docId)
      if (!sample) throw apiError('resource/not-found')
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

    // The renderer may pass a stale docId if the doc was deleted since the snapshot.
    if (!docAccess) throw apiError('internal/forbidden')
    const doc = await getDoc(docAccess)
    if (!doc) {
      throw apiError('docs/not-found')
    }

    // Replay the Y.js log (`yjs_updates`) up to the snapshot; no rows yields an empty
    // doc (zero pages, which the renderer reports as an error).
    //
    // Theme + properties come from the replayed ymeta first, the row only as a
    // fallback: only the OWNER's editor persists them to the row, so other
    // editors' changes live in Y.js alone.
    const snapshotId = payload.snapshotId > 0 ? payload.snapshotId : null
    const ydoc = await reconstructDocAtYjsId(docAccess, snapshotId)
    let markdown: string
    let properties: ReturnType<typeof resolveDocProperties>
    try {
      markdown = ydoc.getText('content').toJSON()
      properties = resolveDocProperties(ydoc.getMap('meta'), doc)
    } finally {
      ydoc.destroy()
    }

    // Short-lived, read-only doc-scoped `file-access` JWT so the print page can
    // load `/api/files/{docId}/...` images on private / password-protected /
    // workspace docs (the renderer has no session cookie). Only /api/files
    // accepts this scope. See server/utils/storage/fileAccessToken.ts.
    const fileAccessToken = mintFileAccessToken(docId, 5 * 60).token

    // Plan gate (authoritative): custom CSS reaches the PDF only when the plan
    // includes it. Y.js writes bypass the API's write-time check, so the render
    // path decides. Built-in preset template CSS is not gated (customCssForPlan).
    //
    // Brand kit: a locked workspace design replaces everything but the cover text
    // (shared/utils/theme/brandLock.ts) before the CSS gate.
    const brand = await resolveDocBrand(docAccess)
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
      // (app/utils/preview/renderFileTokens.ts), never to arbitrary URLs in the
      // content.
      fileIds: (await listConfirmedUploadsForDoc(docAccess)).map(u => u.fileId),
      // Workspace brand kit: fonts to declare, and the files (fonts + logos) the
      // token may go to; `/api/brand/<file>` theme URLs load through
      // `/api/docs/<docId>/brand/<file>`.
      brandFonts: brand.fonts,
      brandFiles: (await listBrandAssetsForDoc(docAccess)).map(a => `${a.id}.${a.format}`),
      // Public app origin(s) — absolute `https://<app>/api/files/…` URLs in
      // custom CSS are treated as this app's (the print page itself is
      // served from the internal container origin, so it can't tell).
      appOrigins: customCssAppOrigins()
    }
  }
})
