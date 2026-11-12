import { withPublishLock } from '../../../../utils/publish/publishDocument'
import { takeDownPublishedPage } from '../../../../utils/publish/takeDown'
import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_DOC_UNPUBLISHED } from '../../../../legal/auditActions'

// DELETE /api/docs/:docId/publish — take the web page down. Owner +
// workspace admins. The address answers 404 at once; a custom domain
// pointing at it stays configured but shows nothing until another page is
// chosen.
export default defineApiHandler({
  access: allow.doc('manage', { deny: 'publish/not-allowed' }),
  handler: async ({ event, docId, doc, docAccess }) => {
    const removed = await withPublishLock(docId, () => takeDownPublishedPage(docAccess))
    if (removed) {
      await appendAuditEvent({
        by: docAccess,
        actorIp: getClientIp(event),
        scope: 'doc',
        scopeId: docId,
        workspaceId: doc.workspaceId,
        action: AUDIT_DOC_UNPUBLISHED,
        metadata: { pageId: removed.id }
      })
    }
    return { published: false, page: null }
  }
})
