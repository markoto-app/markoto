import { requireBrandKitMember } from '../../../../../utils/brandKit/access'
import { deleteBrandObjects } from '../../../../../utils/brandKit/storage'
import { deleteBrandAsset } from '../../../../../repos/brandAssets'
import { appendAuditEvent } from '../../../../../repos/audit'
import { AUDIT_WORKSPACE_BRAND_ASSET_REMOVED } from '../../../../../legal/auditActions'

// DELETE /api/workspaces/:wsId/brand/assets/:assetId — remove a font or
// logo (WP10). Admins; works without the plan feature too (clearing up
// after a downgrade must stay possible). Documents using it fall back to
// the next font in their stack / show no logo.
export default defineEventHandler(async (event) => {
  const { userId, wsId, role } = await requireBrandKitMember(event)
  if (role !== 'admin') throw createError({ statusCode: 403, message: 'Only workspace admins can change the brand kit.', data: { code: 'brand/admin-required' } })
  const assetId = requireRouteParam(event, 'assetId')
  const removed = await deleteBrandAsset(wsId, assetId)
  if (!removed) throw createError({ statusCode: 404, message: 'Not found' })
  await deleteBrandObjects([removed.s3Key])
  await appendAuditEvent({
    actorUserId: userId,
    actorIp: getClientIp(event),
    scope: 'workspace',
    scopeId: wsId,
    action: AUDIT_WORKSPACE_BRAND_ASSET_REMOVED,
    before: removed.kind === 'font'
      ? { kind: 'font', family: removed.name, weight: removed.weight, style: removed.style }
      : { kind: 'image', name: removed.name },
    metadata: { assetId }
  })
  return { ok: true }
})
