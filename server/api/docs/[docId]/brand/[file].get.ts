import { getDocWithActorRole } from '../../../../repos/documents'
import { getBrandAsset } from '../../../../repos/brandAssets'
import { docStateOf, decideFileAccess } from '../../../../../shared/utils/docPermissions'
import { hasValidDocJwt } from '../../../../utils/documents/docTokenVerify'
import { sendBrandAsset } from '../../../../utils/brandKit/storage'
import { BRAND_ASSET_FILE_RE } from '~~/shared/config/brandKit'

// GET /api/docs/:docId/brand/:file — a brand-kit font or logo of the
// document's workspace (WP10), as the document's renderers load it: the
// live preview + print iframes (opaque origin, the file-access token in
// `?token=`), the server render page (same token) and the editor itself
// (session). Same access decision as `/api/files`; the asset must belong
// to the document's workspace. Rate-limited per client because public
// documents make it reachable without an account.

/** Per client (/64 for IPv6) and minute — every preview render loads each workspace font. */
export const DOC_BRAND_FILE_RATE_PER_MINUTE = 300

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)
  const match = BRAND_ASSET_FILE_RE.exec(requireRouteParam(event, 'file'))
  if (!match) throw createError({ statusCode: 400, message: 'Invalid file' })
  if (!(await checkRateLimit('doc-brand-file', getClientRateLimitKey(event), DOC_BRAND_FILE_RATE_PER_MINUTE, 60_000))) {
    throw createError({ statusCode: 429, message: 'Too many requests. Try again in a minute.', data: { code: 'brand/rate-limited', messageKey: 'error.rateLimited' } })
  }
  const session = await getValidatedUserSession(event)
  const row = await getDocWithActorRole(docId, session?.user?.id ?? null)
  if (!row) throw createError({ statusCode: 404, message: 'Document not found' })
  const decision = decideFileAccess(docStateOf(row), {
    userId: session?.user?.id ?? null,
    workspaceRole: row.workspaceRole,
    hasValidDocJwt: hasValidDocJwt(event, docId, ['file-access'])
  })
  if (decision.outcome === 'deny') throw createError({ statusCode: 403, message: 'Access denied' })
  const asset = row.workspaceId ? await getBrandAsset(row.workspaceId, match[1]!) : null
  if (!asset || asset.format !== match[2]) throw createError({ statusCode: 404, message: 'Not found' })
  return sendBrandAsset(event, asset, { crossOrigin: true })
})
