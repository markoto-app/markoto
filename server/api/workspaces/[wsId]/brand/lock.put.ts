import { requireBrandKitAdmin, requireBrandKitMember } from '../../../../utils/brandKit/access'
import { getWorkspace, updateWorkspace } from '../../../../repos/workspaces'
import { listDocIdsInWorkspace } from '../../../../repos/documents'
import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_WORKSPACE_BRAND_LOCK_CHANGED } from '../../../../legal/auditActions'

// PUT /api/workspaces/:wsId/brand/lock — {locked: boolean}. While
// locked, every document in the workspace renders with the workspace
// design (its default theme) and keeps only its cover text — enforced at
// render time (shared/utils/theme/brandLock.ts), documents' own themes stay as
// they are. Locking: admins, plan feature `brandKit`, a workspace design
// must be set. Unlocking: admins, always (also after a downgrade).
export default defineEventHandler(async (event) => {
  const body = await readBody<{ locked?: unknown }>(event)
  if (typeof body?.locked !== 'boolean') {
    throw createError({ statusCode: 400, message: 'locked must be true or false', data: { code: 'brand/invalid' } })
  }
  let userId: number
  let wsId: string
  if (body.locked) {
    ({ userId, wsId } = await requireBrandKitAdmin(event))
  } else {
    const ctx = await requireBrandKitMember(event)
    if (ctx.role !== 'admin') throw createError({ statusCode: 403, message: 'Only workspace admins can change the brand kit.', data: { code: 'brand/admin-required' } })
    ;({ userId, wsId } = ctx)
  }
  const ws = await getWorkspace(wsId)
  if (!ws) throw createError({ statusCode: 404, message: 'Workspace not found' })
  if (body.locked && !ws.defaultTheme) {
    throw createError({ statusCode: 409, message: 'Choose the workspace design first.', data: { code: 'brand/no-design', messageKey: 'brandKit.noDesign' } })
  }
  if (ws.brandLocked !== body.locked) {
    await updateWorkspace(wsId, { brandLocked: body.locked })
    await appendAuditEvent({
      actorUserId: userId,
      actorIp: getClientIp(event),
      scope: 'workspace',
      scopeId: wsId,
      action: AUDIT_WORKSPACE_BRAND_LOCK_CHANGED,
      before: { locked: ws.brandLocked },
      after: { locked: body.locked },
      metadata: { documents: (await listDocIdsInWorkspace(wsId)).length }
    })
  }
  return { locked: body.locked }
})
