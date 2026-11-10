import { requireBrandKitMember } from '../../../../../utils/brandKit/access'
import { sendBrandAsset } from '../../../../../utils/brandKit/storage'
import { getBrandAsset } from '../../../../../repos/brandAssets'
import { BRAND_ASSET_FILE_RE } from '~~/shared/config/brandKit'

// GET /api/workspaces/:wsId/brand/files/:file — a brand-kit file for the
// workspace's members (WP10): previews in the brand-kit tab and the theme
// panel's font / logo pickers (same origin, session). Documents load
// their fonts through `/api/docs/:docId/brand/:file`.
export default defineEventHandler(async (event) => {
  const { wsId } = await requireBrandKitMember(event)
  const match = BRAND_ASSET_FILE_RE.exec(requireRouteParam(event, 'file'))
  if (!match) throw createError({ statusCode: 400, message: 'Invalid file' })
  const asset = await getBrandAsset(wsId, match[1]!)
  if (!asset || asset.format !== match[2]) throw createError({ statusCode: 404, message: 'Not found' })
  return sendBrandAsset(event, asset, { crossOrigin: false })
})
