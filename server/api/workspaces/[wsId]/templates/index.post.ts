import { nanoid } from 'nanoid'
import { BRAND_KIT_PLAN_MESSAGE } from '../../../../utils/brandKit/access'
import { countWorkspaceTemplates, insertWorkspaceTemplate } from '../../../../repos/workspaceTemplates'
import { getDoc } from '../../../../repos/documents'
import { DuplicateError } from '../../../../repos/errors'
import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_WORKSPACE_TEMPLATE_ADDED } from '../../../../legal/auditActions'
import { createTemplateBody } from '~~/shared/api/brand'
import { WORKSPACE_TEMPLATES_PER_WORKSPACE } from '~~/shared/config/brandKit'

// POST /api/workspaces/:wsId/templates — {docId, name, description?}
// — make one of the workspace's documents a template. Admins, plan
// feature `brandKit`. Live link: edits to the document change what new
// documents start with.
export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'brand/admin-required' }),
  plan: { feature: 'brandKit', message: BRAND_KIT_PLAN_MESSAGE },
  body: createTemplateBody,
  invalidCode: 'template/invalid',
  handler: async ({ event, user, wsId, body: { docId, name, description: rawDescription } }) => {
    const description = rawDescription ?? ''
    const doc = await getDoc(docId)
    if (!doc || doc.workspaceId !== wsId) throw apiError('template/doc-not-found')
    if (await countWorkspaceTemplates(wsId) >= WORKSPACE_TEMPLATES_PER_WORKSPACE) {
      throw apiError('template/too-many', { limit: WORKSPACE_TEMPLATES_PER_WORKSPACE })
    }
    const id = nanoid(12)
    try {
      await insertWorkspaceTemplate({ id, workspaceId: wsId, docId, name, description, createdBy: user.id })
    } catch (e) {
      if (e instanceof DuplicateError) throw apiError('template/exists')
      throw e
    }
    await appendAuditEvent({
      actorUserId: user.id,
      actorIp: getClientIp(event),
      scope: 'workspace',
      scopeId: wsId,
      action: AUDIT_WORKSPACE_TEMPLATE_ADDED,
      after: { name },
      metadata: { templateId: id, docId }
    })
    setResponseStatus(event, 201)
    return { id, name, description, docId, docTitle: doc.title }
  }
})
