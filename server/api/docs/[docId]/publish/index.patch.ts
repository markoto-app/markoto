import { requirePublishManager, publishView, readPublishFields } from '../../../../utils/publish/access'
import { slugConflict } from '../../../../utils/publish/publishDocument'
import { getPublishedPageSummary, updatePublishSettings } from '../../../../repos/publishedPages'
import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_DOC_PUBLISH_SETTINGS_CHANGED } from '../../../../legal/auditActions'
import { assertNotModerationRestricted } from '../../../../utils/privacy/moderationRestriction'
import { PUBLISH_ERROR_CODES } from '~~/shared/config/publish'

// PATCH /api/docs/:docId/publish — {slug?, indexable?} without
// re-rendering (WP13). A new slug frees the old address at once.
export default defineEventHandler(async (event) => {
  const { userId, docId, doc } = await requirePublishManager(event)
  assertNotModerationRestricted(doc)
  const fields = readPublishFields(await readBody(event).catch(() => ({})))
  const before = await getPublishedPageSummary(docId)
  if (!before) throw createError({ statusCode: 404, message: 'This document is not published.', data: { code: PUBLISH_ERROR_CODES.notPublished } })
  if (fields.slug && fields.slug !== before.slug) await slugConflict(fields.slug, docId)
  let page: typeof before
  try {
    page = (await updatePublishSettings(docId, fields)) ?? before
  } catch (e) {
    if ((e as { code?: string }).code === '23505' || (e as { cause?: { code?: string } }).cause?.code === '23505') {
      throw createError({ statusCode: 409, message: 'This address is already taken. Choose another one.', data: { code: PUBLISH_ERROR_CODES.slugTaken } })
    }
    throw e
  }
  if (page.slug !== before.slug || page.indexable !== before.indexable) {
    await appendAuditEvent({
      actorUserId: userId,
      actorIp: getClientIp(event),
      scope: 'doc',
      scopeId: docId,
      workspaceId: doc.workspaceId,
      action: AUDIT_DOC_PUBLISH_SETTINGS_CHANGED,
      before: { slug: before.slug, indexable: before.indexable },
      after: { slug: page.slug, indexable: page.indexable }
    })
  }
  return publishView(event, page)
})
