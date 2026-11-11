import { BRAND_KIT_PLAN_MESSAGE } from '../../../../../utils/brandKit/access'
import { updateWorkspaceTemplate } from '../../../../../repos/workspaceTemplates'
import { templateParams, updateTemplateBody } from '~~/shared/api/brand'

// PATCH /api/workspaces/:wsId/templates/:templateId — {name?, description?} (admins).
export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'brand/admin-required' }),
  plan: { feature: 'brandKit', message: BRAND_KIT_PLAN_MESSAGE },
  params: templateParams,
  body: updateTemplateBody,
  invalidCode: 'template/invalid',
  handler: async ({ wsId, params: { templateId: id }, body }) => {
    const patch: { name?: string, description?: string } = {}
    if (body?.name !== undefined) patch.name = body.name
    if (body?.description !== undefined) patch.description = body.description
    if (Object.keys(patch).length && !(await updateWorkspaceTemplate(wsId, id, patch))) throw apiError('resource/not-found')
    return { ok: true }
  }
})
