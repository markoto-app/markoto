import { nanoid } from 'nanoid'
import { requireBrandKitMember } from '../../../../../utils/brandKit/access'
import { getWorkspaceTemplate } from '../../../../../repos/workspaceTemplates'
import { duplicateDocument, ImageQuotaExceededError } from '../../../../../utils/duplicateDocument'
import { imageQuotaError, resolveImageQuota } from '../../../../../utils/imageQuota'
import { flushSyncDocument } from '../../../../../utils/syncNotify'
import { withIdempotency } from '../../../../../utils/idempotency'
import { TITLE_MAX_LENGTH } from '../../../../../utils/createDocument'

// POST /api/workspaces/:wsId/templates/:templateId/documents — {title?}
// (WP10c): a new document in the workspace from a template — a copy of
// the template document's CURRENT text, design and images (the copy is
// the caller's, starts private, images count against the workspace pool
// or the caller's quota). Admins and editors (like creating any document
// there); templates keep working after a downgrade — only adding new
// ones needs the plan.
export default defineEventHandler(async (event) => {
  const { userId, wsId, role } = await requireBrandKitMember(event)
  if (role !== 'admin' && role !== 'editor') {
    throw createError({ statusCode: 403, message: 'Viewers can\'t create documents in this workspace.', data: { code: 'workspace/role-required' } })
  }
  const template = await getWorkspaceTemplate(wsId, requireRouteParam(event, 'templateId'))
  if (!template) throw createError({ statusCode: 404, message: 'Template not found' })
  const body = ((await readBody(event).catch(() => null)) ?? {}) as { title?: unknown }
  const rawTitle = typeof body.title === 'string' ? body.title.trim() : ''
  if (rawTitle.length > TITLE_MAX_LENGTH) throw createError({ statusCode: 400, message: `Title too long (max ${TITLE_MAX_LENGTH})` })
  const title = rawTitle || template.name

  return withIdempotency(event, `template-doc:${template.id}`, userId, async () => {
    const newDocId = nanoid(10)
    const imageQuota = await resolveImageQuota(userId, null, wsId)
    await flushSyncDocument(template.docId)
    try {
      await duplicateDocument(
        { sourceDocId: template.docId, newDocId, ownerId: userId, workspaceId: wsId, title, fromTemplate: true },
        { s3: useS3Client(), bucket: useRuntimeConfig().s3.bucket, imageQuota }
      )
    } catch (e) {
      if (e instanceof ImageQuotaExceededError) throw imageQuotaError(e.limitBytes)
      throw e
    }
    setResponseStatus(event, 201)
    return { docId: newDocId }
  })
})
