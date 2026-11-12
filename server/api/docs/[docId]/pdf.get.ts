import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { canDownload } from '../../../../shared/utils/documents/docPermissions'
import { renderDocument } from '../../../utils/rendering/renderClient'
import { RENDER_RATE_LIMIT } from '../../../utils/rendering/renderRateLimit'
import { docPdfQuery } from '~~/shared/api/docs'
import { useEnv } from '~~/shared/env/load'

// Public-facing PDF download. Authorization mirrors GET /api/files/:docId/:fileId
// (same `decideFileAccess` decision) — anyone who could read the doc's
// in-doc images can download the PDF. Owners, workspace members, password-
// holders (via the JWT cookie), and anonymous users on open-* docs all
// pass; private + non-member is denied; password-protected requires the
// password JWT in the cookie like the file endpoint does.
//
// Flow:
//   1. Auth check via decideFileAccess (`allow.doc('file')`), then the
//      render allowance and the share link's no-download rule.
//   2. renderDocument(format: 'pdf') — cache hit returns near-instantly,
//      cache miss kicks the renderer container (~5-15s).
//   3. Mint a 120s presigned GET against the manifest's pdfKey, with the
//      response Content-Disposition forced to attachment so browsers
//      download instead of displaying inline.
//   4. 302 redirect — or, with `?response=json`, `{ url }` (same
//      presigned URL, `no-store`). The marketing `::try-it` block uses it
//      so a refusal (429 / 502 / 503) reaches its script as an error it
//      can explain, instead of navigating the tab to a JSON error page.

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
      throw apiError('docs/render-failed', undefined, { cause: e })
    }

    const pdfKey = result.manifest.pdfKey
    if (!pdfKey) {
      throw apiError('internal', undefined, { cause: new Error('Manifest missing pdfKey') })
    }

    const env = useEnv()
    const s3 = usePresignS3Client()

    // ResponseContentDisposition rides in the presigned URL so we don't have
    // to proxy the bytes through Nuxt — S3 stamps the header at fetch time.
    // Two modes:
    //   ?inline=1  → "inline" disposition, browsers render the PDF in-tab
    //                (used by "Open PDF" menu item, opens via window.open).
    //   default    → "attachment" forces a download dialog.
    // Filename uses the doc's title with characters problematic for HTTP
    // headers stripped.
    const inline = query.inline === '1' || query.inline === 'true'
    const safeName = (row.title || 'document').replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 80) || 'document'
    const disposition = inline
      ? `inline; filename="${safeName}.pdf"`
      : `attachment; filename="${safeName}.pdf"`
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: env.storage.bucket,
        Key: pdfKey,
        ResponseContentDisposition: disposition,
        ResponseContentType: 'application/pdf',
        // The PDF bytes are as private as the doc: no shared caching.
        ResponseCacheControl: PRIVATE_NO_STORE
      }),
      { expiresIn: 120 }
    )

    if (query.response === 'json') {
      setResponseHeader(event, 'Cache-Control', PRIVATE_NO_STORE)
      return { url }
    }
    return sendPrivateRedirect(event, url)
  }
})
