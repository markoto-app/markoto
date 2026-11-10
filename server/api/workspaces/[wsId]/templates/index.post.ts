import { nanoid } from 'nanoid'
import { requireBrandKitAdmin } from '../../../../utils/brandKit/access'
import { parseTemplateDescription, parseTemplateName } from '../../../../utils/brandKit/templateInput'
import { countWorkspaceTemplates, insertWorkspaceTemplate } from '../../../../repos/workspaceTemplates'
import { getDoc } from '../../../../repos/documents'
import { DuplicateError } from '../../../../repos/errors'
import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_WORKSPACE_TEMPLATE_ADDED } from '../../../../legal/auditActions'
import { WORKSPACE_TEMPLATES_PER_WORKSPACE } from '~~/shared/config/brandKit'

// POST /api/workspaces/:wsId/templates — {docId, name, description?}
// (WP10c): make one of the workspace's documents a template. Admins, plan
// feature `brandKit`. Live link: edits to the document change what new
// documents start with.
export default defineEventHandler(async (event) => {
  const { userId, wsId } = await requireBrandKitAdmin(event)
  const body = await readBody<{ docId?: unknown, name?: unknown, description?: unknown }>(event)
  const name = parseTemplateName(body?.name, true)!
  const description = parseTemplateDescription(body?.description) ?? ''
  const docId = typeof body?.docId === 'string' ? body.docId : ''
  const doc = docId ? await getDoc(docId) : null
  if (!doc || doc.workspaceId !== wsId) throw createError({ statusCode: 404, message: 'Document not found in this workspace', data: { code: 'template/doc-not-found' } })
  if (await countWorkspaceTemplates(wsId) >= WORKSPACE_TEMPLATES_PER_WORKSPACE) {
    throw createError({ statusCode: 409, message: `A workspace can have up to ${WORKSPACE_TEMPLATES_PER_WORKSPACE} templates.`, data: { code: 'template/too-many', limit: WORKSPACE_TEMPLATES_PER_WORKSPACE } })
  }
  const id = nanoid(12)
  try {
    await insertWorkspaceTemplate({ id, workspaceId: wsId, docId, name, description, createdBy: userId })
  } catch (e) {
    if (e instanceof DuplicateError) throw createError({ statusCode: 409, message: 'This document is already a template.', data: { code: 'template/exists' } })
    throw e
  }
  await appendAuditEvent({
    actorUserId: userId,
    actorIp: getClientIp(event),
    scope: 'workspace',
    scopeId: wsId,
    action: AUDIT_WORKSPACE_TEMPLATE_ADDED,
    after: { name },
    metadata: { templateId: id, docId }
  })
  setResponseStatus(event, 201)
  return { id, name, description, docId, docTitle: doc.title }
})
