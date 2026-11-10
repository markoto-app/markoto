import { requirePublishManager, publishView, readPublishFields } from '../../../../utils/publish/access'
import { publishDocument } from '../../../../utils/publish/publishDocument'
import { getPublishedPageSummary } from '../../../../repos/publishedPages'
import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_DOC_PUBLISHED } from '../../../../legal/auditActions'
import { PUBLISH_RATE_PER_HOUR } from '~~/shared/config/publish'

// POST /api/docs/:docId/publish — {slug?, indexable?}. Publishes the
// document's current state as a static web page at /p/<slug>, or replaces
// the published snapshot (WP13). Owner + workspace admins; free on every
// plan. Audited `doc.published`.
export default defineEventHandler(async (event) => {
  const { userId, docId, doc } = await requirePublishManager(event)
  const fields = readPublishFields(await readBody(event).catch(() => ({})))
  if (!(await checkRateLimit('publish', String(userId), PUBLISH_RATE_PER_HOUR, 3_600_000))) {
    throw createError({ statusCode: 429, message: 'Too many publishes. Try again later.', data: { code: 'publish/rate-limited' } })
  }
  const before = await getPublishedPageSummary(docId)
  const page = await publishDocument({ docId, workspaceId: doc.workspaceId, title: doc.title, userId, ...fields })
  await appendAuditEvent({
    actorUserId: userId,
    actorIp: getClientIp(event),
    scope: 'doc',
    scopeId: docId,
    workspaceId: doc.workspaceId,
    action: AUDIT_DOC_PUBLISHED,
    metadata: { pageId: page.id, slug: page.slug, republish: before !== null, indexable: page.indexable }
  })
  return publishView(event, page)
})
