import { publishView } from '../../../../utils/publish/access'
import { slugConflict } from '../../../../utils/publish/publishDocument'
import { getDoc } from '../../../../repos/documents'
import { getPublishedPageSummary, updatePublishSettings } from '../../../../repos/publishedPages'
import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_DOC_PUBLISH_SETTINGS_CHANGED } from '../../../../legal/auditActions'
import { assertNotModerationRestricted } from '../../../../utils/privacy/moderationRestriction'
import { PUBLISH_SLUG_RE } from '~~/shared/config/publish'
import { publishDocBody } from '~~/shared/api/sharing'

// PATCH /api/docs/:docId/publish — {slug?, indexable?} without
// re-rendering. Owner + workspace admins. A new slug frees the old
// address at once.
export default defineApiHandler({
  access: allow.doc('manage', { deny: 'publish/not-allowed' }),
  body: publishDocBody,
  invalidCode: 'publish/invalid',
  handler: async ({ event, docId, doc, docAccess, body }) => {
    assertNotModerationRestricted(await getDoc(docAccess))
    const fields: { slug?: string, indexable?: boolean } = {}
    if (body?.slug) {
      if (!PUBLISH_SLUG_RE.test(body.slug)) throw apiError('publish/slug-invalid', { field: 'slug' })
      fields.slug = body.slug
    }
    if (body?.indexable !== undefined) fields.indexable = body.indexable
    const before = await getPublishedPageSummary(docAccess)
    if (!before) throw apiError('publish/not-published')
    if (fields.slug && fields.slug !== before.slug) await slugConflict(docAccess, fields.slug)
    let page: typeof before
    try {
      page = (await updatePublishSettings(docAccess, fields)) ?? before
    } catch (e) {
      // Another document took the address between the check and the write.
      if ((e as { code?: string }).code === '23505' || (e as { cause?: { code?: string } }).cause?.code === '23505') {
        throw apiError('publish/slug-taken')
      }
      throw e
    }
    if (page.slug !== before.slug || page.indexable !== before.indexable) {
      await appendAuditEvent({
        by: docAccess,
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
  }
})
