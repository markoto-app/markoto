import { brandKitAvailable } from '../../../../utils/brandKit/access'
import { isBrandFontAsset, isBrandImageAsset, listBrandAssets } from '../../../../repos/brandAssets'
import { BRAND_FONTS_PER_WORKSPACE, BRAND_IMAGES_PER_WORKSPACE } from '~~/shared/config/brandKit'

// GET /api/workspaces/:wsId/brand — the workspace's brand kit for
// its members: fonts and logos (the theme panel offers them), whether
// the plan includes the kit, and the limits. Admins manage it in the
// workspace's Brand kit tab.
export default defineApiHandler({
  access: allow.workspace('member'),
  handler: async ({ event, wsId, role }) => {
    const assets = await listBrandAssets(wsId)
    setHeader(event, 'cache-control', 'private, no-store')
    return {
      available: await brandKitAvailable(wsId),
      canManage: role === 'admin',
      limits: { fonts: BRAND_FONTS_PER_WORKSPACE, images: BRAND_IMAGES_PER_WORKSPACE },
      fonts: assets.filter(isBrandFontAsset).map(a => ({
        id: a.id,
        file: `${a.id}.${a.format}`,
        family: a.name,
        weight: a.weight ?? 400,
        style: a.style ?? 'normal',
        format: a.format,
        sizeBytes: a.sizeBytes,
        createdAt: a.createdAt
      })),
      images: assets.filter(isBrandImageAsset).map(a => ({
        id: a.id,
        file: `${a.id}.${a.format}`,
        name: a.name,
        format: a.format,
        sizeBytes: a.sizeBytes,
        url: `/api/brand/${a.id}.${a.format}`,
        createdAt: a.createdAt
      }))
    }
  }
})
