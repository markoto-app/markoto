import { publishView } from '../../../../utils/publish/access'
import { publishDocument } from '../../../../utils/publish/publishDocument'
import { getDoc } from '../../../../repos/documents'
import { getPublishedPageSummary } from '../../../../repos/publishedPages'
import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_DOC_PUBLISHED } from '../../../../legal/auditActions'
import { assertNotModerationRestricted } from '../../../../utils/privacy/moderationRestriction'
import { PUBLISH_RATE_PER_HOUR, PUBLISH_SLUG_RE } from '~~/shared/config/publish'
import { HOUR_MS } from '~~/shared/config/units'
import { publishDocBody } from '~~/shared/api/sharing'

// POST /api/docs/:docId/publish — {slug?, indexable?}. Publishes the
// document's current state as a static web page at /p/<slug>, or replaces
// the published snapshot. Owner + workspace admins; free on every
// plan. Audited `doc.published`.
export default defineApiHandler({
  access: allow.doc('manage', { deny: 'publish/not-allowed' }),
  body: publishDocBody,
  invalidCode: 'publish/invalid',
  rateLimit: { namespace: 'publish', max: PUBLISH_RATE_PER_HOUR, windowMs: HOUR_MS, key: 'user', error: 'publish/rate-limited' },
  handler: async ({ event, user, docId, doc, body }) => {
    // Publishing makes the content public: refused while restricted
    // (publishDocument checks again after the render).
    assertNotModerationRestricted(await getDoc(docId))
    const slug = body?.slug || undefined
    if (slug !== undefined && !PUBLISH_SLUG_RE.test(slug)) throw apiError('publish/slug-invalid', { field: 'slug' })
    const before = await getPublishedPageSummary(docId)
    const page = await publishDocument({ docId, workspaceId: doc.workspaceId, title: doc.title, userId: user.id, slug, indexable: body?.indexable })
    await appendAuditEvent({
      actorUserId: user.id,
      actorIp: getClientIp(event),
      scope: 'doc',
      scopeId: docId,
      workspaceId: doc.workspaceId,
      action: AUDIT_DOC_PUBLISHED,
      metadata: { pageId: page.id, slug: page.slug, republish: before !== null, indexable: page.indexable }
    })
    return publishView(event, page)
  }
})
