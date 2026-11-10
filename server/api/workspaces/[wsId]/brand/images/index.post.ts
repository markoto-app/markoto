import { fileTypeFromBuffer } from 'file-type'
import { requireBrandKitAdmin } from '../../../../../utils/brandKit/access'
import { newBrandAssetId, readBrandUpload } from '../../../../../utils/brandKit/upload'
import { brandAssetKey, deleteBrandObjects, putBrandObject } from '../../../../../utils/brandKit/storage'
import { countBrandAssets, deleteBrandAsset, insertBrandAsset } from '../../../../../repos/brandAssets'
import { appendAuditEvent } from '../../../../../repos/audit'
import { AUDIT_WORKSPACE_BRAND_ASSET_ADDED } from '../../../../../legal/auditActions'
import { BRAND_IMAGE_MAX_BYTES, BRAND_IMAGES_PER_WORKSPACE, type BrandImageFormat } from '~~/shared/config/brandKit'

// POST /api/workspaces/:wsId/brand/images — upload a logo (WP10).
// Multipart `file`: PNG, JPEG or WebP (no SVG — it can carry script), the
// type decided by the bytes, not the name. Usable as the cover logo and
// header / footer image of every document in the workspace
// (`/api/brand/<id>.<ext>` in a theme).

const BY_MIME: Record<string, BrandImageFormat> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

export default defineEventHandler(async (event) => {
  const { userId, wsId } = await requireBrandKitAdmin(event)
  const { bytes, fileName } = await readBrandUpload(event, BRAND_IMAGE_MAX_BYTES)
  const detected = await fileTypeFromBuffer(bytes)
  const format = detected ? BY_MIME[detected.mime] : undefined
  if (!format) {
    throw createError({ statusCode: 415, message: 'Upload a PNG, JPEG or WebP image.', data: { code: 'brand/image-type' } })
  }
  if (await countBrandAssets(wsId, 'image') >= BRAND_IMAGES_PER_WORKSPACE) {
    throw createError({ statusCode: 409, message: `A workspace can have up to ${BRAND_IMAGES_PER_WORKSPACE} brand images.`, data: { code: 'brand/too-many-images', limit: BRAND_IMAGES_PER_WORKSPACE } })
  }
  // Display name only (never part of a path or URL): the file name
  // without its extension, plain characters, ≤ 80.
  const name = fileName.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^\p{L}\p{N} ._-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Logo'
  const id = newBrandAssetId()
  const key = brandAssetKey(wsId, id, format)
  await insertBrandAsset({ id, workspaceId: wsId, kind: 'image', format, name, weight: null, style: null, sizeBytes: bytes.byteLength, s3Key: key, uploadedBy: userId, licenceConfirmedAt: null })
  try {
    await putBrandObject(key, bytes, format)
  } catch (e) {
    await deleteBrandAsset(wsId, id)
    await deleteBrandObjects([key])
    throw e
  }
  await appendAuditEvent({
    actorUserId: userId,
    actorIp: getClientIp(event),
    scope: 'workspace',
    scopeId: wsId,
    action: AUDIT_WORKSPACE_BRAND_ASSET_ADDED,
    after: { kind: 'image', name, format },
    metadata: { assetId: id, sizeBytes: bytes.byteLength }
  })
  setResponseStatus(event, 201)
  return { id, file: `${id}.${format}`, kind: 'image', name, format, sizeBytes: bytes.byteLength, url: `/api/brand/${id}.${format}` }
})
