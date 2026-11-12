import { sendBrandAsset } from '../../../../../utils/brandKit/storage'
import { getBrandAsset } from '../../../../../repos/brandAssets'
import { brandFileParams } from '~~/shared/api/brand'
import { BRAND_ASSET_FILE_RE } from '~~/shared/config/brandKit'

// GET /api/workspaces/:wsId/brand/files/:file: a brand-kit file for the
// workspace's members: previews in the brand-kit tab and the theme
// panel's font / logo pickers (same origin, session). Documents load
// their fonts through `/api/docs/:docId/brand/:file`.
export default defineApiHandler({
  access: allow.workspace('member'),
  params: brandFileParams,
  handler: async ({ event, params: { file }, workspaceAccess }) => {
    const [, assetId, format] = BRAND_ASSET_FILE_RE.exec(file) ?? []
    const asset = assetId ? await getBrandAsset(workspaceAccess, assetId) : null
    if (!asset || asset.format !== format) throw apiError('resource/not-found')
    return sendBrandAsset(event, asset, { crossOrigin: false })
  }
})
