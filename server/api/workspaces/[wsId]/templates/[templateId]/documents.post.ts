import { nanoid } from 'nanoid'
import { getWorkspaceTemplate } from '../../../../../repos/workspaceTemplates'
import { proveWorkspaceDoc } from '../../../../../utils/access/docProof'
import { duplicateDocument, ImageQuotaExceededError } from '../../../../../utils/documents/duplicateDocument'
import { imageQuotaError, resolveImageQuota } from '../../../../../utils/storage/imageQuota'
import { flushSyncDocument } from '../../../../../utils/documents/syncNotify'
import { withIdempotency } from '../../../../../utils/platform/idempotency'
import { createDocFromTemplateBody, templateParams } from '~~/shared/api/brand'
import { HOUR_MS } from '~~/shared/config/units'
import { useEnv } from '~~/shared/env/load'

// POST /api/workspaces/:wsId/templates/:templateId/documents: {title?}
// A new document in the workspace from a template, a copy of
// the template document's CURRENT text, design and images (the copy is
// the caller's, starts private, images count against the workspace pool
// or the caller's quota). Admins and editors (like creating any document
// there); templates keep working after a downgrade, only adding new
// ones needs the plan. Rate-limited per user: each copy duplicates the
// template's Y.js state and copies its images in storage.

/** Documents from templates per user per hour. */
export const TEMPLATE_DOCUMENTS_PER_HOUR = 60

export default defineApiHandler({
  access: allow.workspace('editor', { deny: 'workspace/role-required' }),
  params: templateParams,
  body: createDocFromTemplateBody,
  rateLimit: { namespace: 'template-document', max: TEMPLATE_DOCUMENTS_PER_HOUR, windowMs: HOUR_MS, key: 'user', error: 'workspace/template-rate-limited' },
  handler: async ({ event, user, self, wsId, workspaceAccess, params: { templateId }, body }) => {
    const template = await getWorkspaceTemplate(workspaceAccess, templateId)
    if (!template) throw apiError('resource/not-found')
    // Templates list only documents still in this workspace; a member reads them.
    const source = await proveWorkspaceDoc(workspaceAccess, template.docId)
    if (!source?.allows('view')) throw apiError('resource/not-found')
    const title = body?.title || template.name

    // Idempotency is keyed by the template, which is only known after the lookup.
    return withIdempotency(event, `template-doc:${template.id}`, user.id, async () => {
      const newDocId = nanoid(10)
      const imageQuota = await resolveImageQuota(user.id, null, wsId)
      await flushSyncDocument(template.docId)
      try {
        await duplicateDocument(
          { source, newDocId, owner: self, workspace: workspaceAccess, title, fromTemplate: true },
          { s3: useS3Client(), bucket: useEnv().storage.bucket, imageQuota }
        )
      } catch (e) {
        if (e instanceof ImageQuotaExceededError) throw imageQuotaError(e.limitBytes)
        throw e
      }
      setResponseStatus(event, 201)
      return { docId: newDocId }
    })
  }
})
