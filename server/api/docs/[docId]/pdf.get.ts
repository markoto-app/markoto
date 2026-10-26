import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getDocWithActorRole } from '../../../repos/documents'
import { decideFileAccess, type DocState, type ActorState } from '../../../../shared/utils/docPermissions'
import { hasValidDocJwt } from '../../../utils/docTokenVerify'
import { renderDocument } from '../../../utils/renderClient'

// Public-facing PDF download. Authorization mirrors GET /api/files/:docId/:fileId
// (same `decideFileAccess` decision) — anyone who could read the doc's
// in-doc images can download the PDF. Owners, workspace members, password-
// holders (via the JWT cookie), and anonymous users on open-* docs all
// pass; private + non-member is denied; password-protected requires the
// password JWT in the cookie like the file endpoint does.
//
// Flow:
//   1. Auth check via decideFileAccess.
//   2. renderDocument(format: 'pdf') — cache hit returns near-instantly,
//      cache miss kicks the renderer container (~5-15s).
//   3. Mint a 120s presigned GET against the manifest's pdfKey, with the
//      response Content-Disposition forced to attachment so browsers
//      download instead of displaying inline.
//   4. 302 redirect.

export default defineEventHandler(async (event) => {
  // Rate limit: 10 PDF downloads per IP per minute. Each cache miss
  // spawns a Playwright render (~5-15s renderer compute), so a tight
  // anonymous loop on an open-edit doc could saturate the renderer
  // pool and starve real users. 10/min is generous for legitimate
  // "view PDF" / "save PDF" traffic but caps the abuse surface.
  // Cache-hit responses are sub-second and still rate-limited (the
  // counter doesn't differentiate hit vs. miss), which is the right
  // call: the limit is on REQUEST volume, not on renderer load.
  const ip = getClientIp(event) ?? 'unknown'
  if (!(await checkRateLimit('pdf-download', ip, 10, 60_000))) {
    throw createError({ statusCode: 429, message: 'Too many PDF requests. Try again in a minute.' })
  }

  const docId = requireDocId(event)

  const session = await getValidatedUserSession(event)
  const row = await getDocWithActorRole(docId, session?.user?.id ?? null)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  const doc: DocState = {
    ownerId: row.ownerId,
    workspaceId: row.workspaceId,
    accessMode: row.accessMode
  }
  const actor: ActorState = {
    userId: session?.user?.id ?? null,
    workspaceRole: row.workspaceRole,
    hasValidDocJwt: hasValidDocJwt(event, docId)
  }

  const decision = decideFileAccess(doc, actor)
  if (decision.outcome === 'deny') {
    throw createError({ statusCode: 403, message: 'Access denied' })
  }

  let result
  try {
    result = await renderDocument(docId, { format: 'pdf' })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'render failed'
    throw createError({ statusCode: 502, message: `PDF generation failed: ${msg}` })
  }

  const pdfKey = result.manifest.pdfKey
  if (!pdfKey) {
    throw createError({ statusCode: 500, message: 'Manifest missing pdfKey' })
  }

  const config = useRuntimeConfig()
  const s3 = usePresignS3Client()

  // ResponseContentDisposition rides in the presigned URL so we don't have
  // to proxy the bytes through Nuxt — S3 stamps the header at fetch time.
  // Two modes:
  //   ?inline=1  → "inline" disposition, browsers render the PDF in-tab
  //                (used by "Open PDF" menu item, opens via window.open).
  //   default    → "attachment" forces a download dialog.
  // Filename uses the doc's title with characters problematic for HTTP
  // headers stripped.
  const inline = getQuery(event).inline === '1' || getQuery(event).inline === 'true'
  const safeName = (row.title || 'document').replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 80) || 'document'
  const disposition = inline
    ? `inline; filename="${safeName}.pdf"`
    : `attachment; filename="${safeName}.pdf"`
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: pdfKey,
      ResponseContentDisposition: disposition,
      ResponseContentType: 'application/pdf'
    }),
    { expiresIn: 120 }
  )

  return sendRedirect(event, url, 302)
})
