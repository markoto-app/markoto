import { requireBrandKitMember } from '../../../../../utils/brandKit/access'
import { deleteWorkspaceTemplate } from '../../../../../repos/workspaceTemplates'
import { appendAuditEvent } from '../../../../../repos/audit'
import { AUDIT_WORKSPACE_TEMPLATE_REMOVED } from '../../../../../legal/auditActions'

// DELETE /api/workspaces/:wsId/templates/:templateId (WP10c) — admins,
// also without the plan feature. The document itself stays.
export default defineEventHandler(async (event) => {
  const { userId, wsId, role } = await requireBrandKitMember(event)
  if (role !== 'admin') throw createError({ statusCode: 403, message: 'Only workspace admins can change the brand kit.', data: { code: 'brand/admin-required' } })
  const id = requireRouteParam(event, 'templateId')
  const removed = await deleteWorkspaceTemplate(wsId, id)
  if (!removed) throw createError({ statusCode: 404, message: 'Template not found' })
  await appendAuditEvent({
    actorUserId: userId,
    actorIp: getClientIp(event),
    scope: 'workspace',
    scopeId: wsId,
    action: AUDIT_WORKSPACE_TEMPLATE_REMOVED,
    metadata: { templateId: id, docId: removed.docId }
  })
  return { ok: true }
})
