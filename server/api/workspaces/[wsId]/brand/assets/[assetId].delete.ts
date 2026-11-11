import { deleteBrandObjects } from '../../../../../utils/brandKit/storage'
import { deleteBrandAsset } from '../../../../../repos/brandAssets'
import { appendAuditEvent } from '../../../../../repos/audit'
import { AUDIT_WORKSPACE_BRAND_ASSET_REMOVED } from '../../../../../legal/auditActions'
import { brandAssetParams } from '~~/shared/api/brand'

// DELETE /api/workspaces/:wsId/brand/assets/:assetId — remove a font or
// logo. Admins; works without the plan feature too (clearing up
// after a downgrade must stay possible). Documents using it fall back to
// the next font in their stack / show no logo.
export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'brand/admin-required' }),
  params: brandAssetParams,
  handler: async ({ event, user, wsId, params: { assetId } }) => {
    const removed = await deleteBrandAsset(wsId, assetId)
    if (!removed) throw apiError('resource/not-found')
    await deleteBrandObjects([removed.s3Key])
    await appendAuditEvent({
      actorUserId: user.id,
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
  }
})
