import { deleteWorkspaceTemplate } from '../../../../../repos/workspaceTemplates'
import { appendAuditEvent } from '../../../../../repos/audit'
import { AUDIT_WORKSPACE_TEMPLATE_REMOVED } from '../../../../../legal/auditActions'
import { templateParams } from '~~/shared/api/brand'

// DELETE /api/workspaces/:wsId/templates/:templateId — admins,
// also without the plan feature. The document itself stays.
export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'brand/admin-required' }),
  params: templateParams,
  handler: async ({ event, user, wsId, params: { templateId: id } }) => {
    const removed = await deleteWorkspaceTemplate(wsId, id)
    if (!removed) throw apiError('resource/not-found')
    await appendAuditEvent({
      actorUserId: user.id,
      actorIp: getClientIp(event),
      scope: 'workspace',
      scopeId: wsId,
      action: AUDIT_WORKSPACE_TEMPLATE_REMOVED,
      metadata: { templateId: id, docId: removed.docId }
    })
    return { ok: true }
  }
})
