import { assertPlanFeature, resolveWorkspacePlan } from '../../../../utils/billing/entitlements'
import { BRAND_KIT_PLAN_MESSAGE } from '../../../../utils/brandKit/access'
import { getWorkspace, updateWorkspace } from '../../../../repos/workspaces'
import { listDocIdsInWorkspace } from '../../../../repos/documents'
import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_WORKSPACE_BRAND_LOCK_CHANGED } from '../../../../legal/auditActions'
import { setBrandLockBody } from '~~/shared/api/brand'

// PUT /api/workspaces/:wsId/brand/lock — {locked: boolean}. While
// locked, every document in the workspace renders with the workspace
// design (its default theme) and keeps only its cover text — enforced at
// render time (shared/utils/theme/brandLock.ts), documents' own themes stay as
// they are. Locking: admins, plan feature `brandKit`, a workspace design
// must be set. Unlocking: admins, always (also after a downgrade).
export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'brand/admin-required' }),
  body: setBrandLockBody,
  invalidCode: 'brand/invalid',
  handler: async ({ event, wsId, body: { locked }, workspaceAccess }) => {
    // Only locking needs the plan; unlocking must stay possible after a downgrade.
    if (locked) assertPlanFeature(await resolveWorkspacePlan(wsId), 'brandKit', BRAND_KIT_PLAN_MESSAGE)
    const ws = await getWorkspace(workspaceAccess)
    if (!ws) throw apiError('workspace/not-found')
    if (locked && !ws.defaultTheme) throw apiError('brand/no-design')
    if (ws.brandLocked !== locked) {
      await updateWorkspace(workspaceAccess, { brandLocked: locked })
      await appendAuditEvent({
        by: workspaceAccess,
        actorIp: getClientIp(event),
        scope: 'workspace',
        scopeId: wsId,
        action: AUDIT_WORKSPACE_BRAND_LOCK_CHANGED,
        before: { locked: ws.brandLocked },
        after: { locked },
        metadata: { documents: (await listDocIdsInWorkspace(workspaceAccess)).length }
      })
    }
    return { locked }
  }
})
