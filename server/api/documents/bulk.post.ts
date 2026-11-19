import { deleteDocsBulk, moveDocsToFolder, moveDocsToWorkspace } from '../../utils/explorer/bulkActions'
import { bulkDocumentsBody } from '~~/shared/api/explorer'

// Act on up to 200 documents at once: file into a folder, move to another
// workspace, delete. Each document is decided like the single-document route
// (edit rights for a folder move, manage for a workspace move, delete rights
// for a delete) and audited one by one; the answer lists a result per
// document (partial success). Its own rate limit: the single delete allows
// 10 a minute, which a selection would exhaust.
export default defineApiHandler({
  access: allow.user(),
  body: bulkDocumentsBody,
  rateLimit: { namespace: 'bulk', max: 30, windowMs: 60_000, key: 'user' },
  idempotency: { scope: 'documents-bulk' },
  handler: async ({ event, user, prove, body }) => {
    const actor = { userId: user.id, ip: getClientIp(event) }
    const results = body.action === 'move-folder'
      ? await moveDocsToFolder(actor, body.docIds, body.folderId)
      : body.action === 'move-workspace'
        ? await moveDocsToWorkspace(actor, prove, body.docIds, body.workspaceId)
        : await deleteDocsBulk(actor, body.docIds, { reason: 'bulk' })
    return { results, ok: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }
  }
})
