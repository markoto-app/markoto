import { getBrandAsset } from '../../../../repos/brandAssets'
import { sendBrandAsset } from '../../../../utils/brandKit/storage'
import { brandFileParams } from '~~/shared/api/brand'
import { BRAND_ASSET_FILE_RE } from '~~/shared/config/brandKit'
import { MINUTE_MS } from '~~/shared/config/units'

// GET /api/docs/:docId/brand/:file — a brand-kit font or logo of the
// document's workspace, as the document's renderers load it: the
// live preview + print iframes (opaque origin, the file-access token in
// `?token=`), the server render page (same token) and the editor itself
// (session). Same access decision as `/api/files`; the asset must belong
// to the document's workspace. Rate-limited per client because public
// documents make it reachable without an account.

/** Per client (/64 for IPv6) and minute — every preview render loads each workspace font. */
export const DOC_BRAND_FILE_RATE_PER_MINUTE = 300

export default defineApiHandler({
  access: allow.doc('file', { anonymous: true, jwt: ['file-access'], deny: 'files/access-denied' }),
  params: brandFileParams,
  rateLimit: { namespace: 'doc-brand-file', max: DOC_BRAND_FILE_RATE_PER_MINUTE, windowMs: MINUTE_MS, key: 'ip', error: 'brand/rate-limited' },
  handler: async ({ event, doc, params: { file } }) => {
    const [, assetId, format] = BRAND_ASSET_FILE_RE.exec(file) ?? []
    const asset = doc.workspaceId && assetId ? await getBrandAsset(doc.workspaceId, assetId) : null
    if (!asset || asset.format !== format) throw apiError('resource/not-found')
    return sendBrandAsset(event, asset, { crossOrigin: true })
  }
})
