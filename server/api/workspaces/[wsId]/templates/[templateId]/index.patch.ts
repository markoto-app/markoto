import { requireBrandKitAdmin } from '../../../../../utils/brandKit/access'
import { parseTemplateDescription, parseTemplateName } from '../../../../../utils/brandKit/templateInput'
import { updateWorkspaceTemplate } from '../../../../../repos/workspaceTemplates'

// PATCH /api/workspaces/:wsId/templates/:templateId — {name?, description?} (WP10c, admins).
export default defineEventHandler(async (event) => {
  const { wsId } = await requireBrandKitAdmin(event)
  const id = requireRouteParam(event, 'templateId')
  const body = await readBody<{ name?: unknown, description?: unknown }>(event)
  const patch: { name?: string, description?: string } = {}
  const name = parseTemplateName(body?.name, false)
  if (name !== undefined) patch.name = name
  const description = parseTemplateDescription(body?.description)
  if (description !== undefined) patch.description = description
  if (Object.keys(patch).length && !(await updateWorkspaceTemplate(wsId, id, patch))) throw createError({ statusCode: 404, message: 'Template not found' })
  return { ok: true }
})
