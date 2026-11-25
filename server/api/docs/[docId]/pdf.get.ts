import { canDownload } from '../../../../shared/utils/documents/docPermissions'
import { renderDocument, RenderTimeoutError } from '../../../utils/rendering/renderClient'
import { RENDER_RATE_LIMIT } from '../../../utils/rendering/renderRateLimit'
import { docPdfQuery } from '~~/shared/api/docs'
import { openRenderedPdf, pdfContentDisposition } from '../../../utils/rendering/pdfResponse'

// Public-facing PDF download. Authorization mirrors GET /api/files/:docId/:fileId
// (same `decideFileAccess` decision): anyone who could read the doc's
// in-doc images can download the PDF. Owners, workspace members, password-
// holders (via the JWT cookie), and anonymous users on open-* docs all
// pass; private + non-member is denied; password-protected requires the
// password JWT in the cookie like the file endpoint does.
//
// Flow:
//   1. Auth check via decideFileAccess (`allow.doc('file')`), then the
//      render allowance and the share link's no-download rule.
//   2. renderDocument(format: 'pdf'): cache hit returns near-instantly,
//      cache miss kicks the renderer container (~5-15s). The call gives up
//      after RENDER_DEADLINE_MS (504 `docs/render-timeout`), well inside the
//      app server's idle timeout, so a slow render never ends in an empty reply.
//   3. Stream the cached PDF from S3 through the app (`private, no-store`,
//      Content-Disposition attachment unless `?inline=1`). The browser
//      never sees a storage URL. Refusals (429 / 502 / 503 / 504) are JSON
//      errors with a code, so the marketing `::try-it` block fetches the
//      bytes itself and can explain a failure.

export default defineApiHandler({
  access: allow.doc('file', { anonymous: true, jwt: true, deny: 'files/access-denied' }),
  query: docPdfQuery,
  // Rate limit: 10 renders per client per minute, the same allowance as the
  // MCP render tools (`renderRateLimit.ts`). Each cache miss spawns a
  // Playwright render (~5-15s renderer compute), so a tight anonymous loop on
  // an open-edit doc could saturate the renderer pool and starve real users.
  // Cache-hit responses are sub-second and still rate-limited (the counter
  // doesn't differentiate hit vs. miss): the limit is on REQUEST volume, not
  // renderer load. Counted before the lookup, so unknown ids count too.
  rateLimit: { ...RENDER_RATE_LIMIT, key: 'ip', phase: 'before-access' },
  handler: async ({ event, docAccess, doc: row, state: doc, actor, query }) => {
    // Share-link controls: view-only without download for visitors.
    if (!canDownload(doc, actor, row.shareNoDownload)) {
      throw apiError('share/download-disabled')
    }

    let result
    try {
      result = await renderDocument(docAccess, { format: 'pdf' })
    } catch (e) {
      // Too slow (renderer queue full, deadline reached): 504, so the
      // client can tell "try again in a moment" from a broken render.
      if (e instanceof RenderTimeoutError) throw apiError('docs/render-timeout', undefined, { cause: e })
      throw apiError('docs/render-failed', undefined, { cause: e })
    }

    const pdfKey = result.manifest.pdfKey
    if (!pdfKey) {
      throw apiError('internal', undefined, { cause: new Error('Manifest missing pdfKey') })
    }

    // Streamed from the render cache through the app, never buffered: the
    // browser sees a markoto.app address, not the storage host, and the
    // response carries our own headers.
    //   ?inline=1  → "inline" disposition, browsers render the PDF in-tab
    //                (used by the "Open PDF" menu item).
    //   default    → "attachment" forces a download dialog.
    const inline = query.inline === '1' || query.inline === 'true'
    const body = await openRenderedPdf(pdfKey)
    setResponseHeaders(event, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': pdfContentDisposition(row.title, inline),
      // The PDF bytes are as private as the doc: no shared caching.
      'Cache-Control': PRIVATE_NO_STORE,
      'X-Content-Type-Options': 'nosniff',
      // A PDF, not an app page: the app's policy (`object-src 'none'`)
      // can stop the browser's built-in PDF viewer of an `inline` open.
      // Nothing here runs scripts; only framing by other sites is refused.
      'Content-Security-Policy': 'frame-ancestors \'none\''
    })
    if (body.length !== undefined) setResponseHeader(event, 'Content-Length', body.length)
    return body.stream
  }
})
