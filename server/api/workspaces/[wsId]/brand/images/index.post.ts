import { fileTypeFromBuffer } from 'file-type'
import { BRAND_KIT_PLAN_MESSAGE } from '../../../../../utils/brandKit/access'
import { newBrandAssetId, readBrandUpload } from '../../../../../utils/brandKit/upload'
import { brandAssetKey, deleteBrandObjects, putBrandObject } from '../../../../../utils/brandKit/storage'
import { countBrandAssets, insertBrandAsset } from '../../../../../repos/brandAssets'
import { appendAuditEvent } from '../../../../../repos/audit'
import { AUDIT_WORKSPACE_BRAND_ASSET_ADDED } from '../../../../../legal/auditActions'
import { HOUR_MS } from '~~/shared/config/units'
import { BRAND_IMAGE_MAX_BYTES, BRAND_IMAGES_PER_WORKSPACE, type BrandImageFormat } from '~~/shared/config/brandKit'

// POST /api/workspaces/:wsId/brand/images — upload a logo.
// Multipart `file`: PNG, JPEG or WebP (no SVG — it can carry script), the
// type decided by the bytes, not the name. Usable as the cover logo and
// header / footer image of every document in the workspace
// (`/api/brand/<id>.<ext>` in a theme).

const BY_MIME: Record<string, BrandImageFormat> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'brand/admin-required' }),
  plan: { feature: 'brandKit', message: BRAND_KIT_PLAN_MESSAGE },
  body: 'multipart',
  rateLimit: { namespace: 'brand-upload', max: 60, windowMs: HOUR_MS, key: ctx => ctx.wsId, error: 'brand/rate-limited' },
  handler: async ({ event, user, wsId, workspaceAccess }) => {
    const { bytes, fileName } = await readBrandUpload(event, BRAND_IMAGE_MAX_BYTES)
    const detected = await fileTypeFromBuffer(bytes)
    const format = detected ? BY_MIME[detected.mime] : undefined
    if (!format) {
      throw apiError('brand/image-type')
    }
    if (await countBrandAssets(workspaceAccess, 'image') >= BRAND_IMAGES_PER_WORKSPACE) throw tooManyImages()
    // Display name only (never part of a path or URL): the file name
    // without its extension, plain characters, ≤ 80.
    const name = fileName.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^\p{L}\p{N} ._-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Logo'
    const id = newBrandAssetId()
    const key = brandAssetKey(wsId, id, format)
    // Object first, then the row (see fonts/index.post.ts).
    await putBrandObject(key, bytes, format)
    let inserted: 'inserted' | 'limit'
    try {
      inserted = await insertBrandAsset(workspaceAccess, { id, kind: 'image', format, name, weight: null, style: null, sizeBytes: bytes.byteLength, s3Key: key, uploadedBy: user.id, licenceConfirmedAt: null }, BRAND_IMAGES_PER_WORKSPACE)
    } catch (e) {
      await deleteBrandObjects([key])
      throw e
    }
    if (inserted === 'limit') {
      await deleteBrandObjects([key])
      throw tooManyImages()
    }
    await appendAuditEvent({
      by: workspaceAccess,
      actorIp: getClientIp(event),
      scope: 'workspace',
      scopeId: wsId,
      action: AUDIT_WORKSPACE_BRAND_ASSET_ADDED,
      after: { kind: 'image', name, format },
      metadata: { assetId: id, sizeBytes: bytes.byteLength }
    })
    setResponseStatus(event, 201)
    return { id, file: `${id}.${format}`, kind: 'image', name, format, sizeBytes: bytes.byteLength, url: `/api/brand/${id}.${format}` }
  }
})

function tooManyImages() {
  return apiError('brand/too-many-images', { limit: BRAND_IMAGES_PER_WORKSPACE })
}
