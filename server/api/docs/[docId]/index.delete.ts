import { getDoc } from '../../../repos/documents'
import { deleteDocument } from '../../../utils/documents/documentLifecycle'
import { appendAuditEvent } from '../../../repos/audit'
import { MINUTE_MS } from '~~/shared/config/units'

// Delete a document. Authorisation is decided by `decideDocDelete`
// (`allow.doc('delete')`):
//   - anonymous doc (no owner, no workspace) → only the browser that
//     created it, proven by the httpOnly creator-key cookie whose hash
//     is stored on the row (`utils/anonCreator.ts`). Others with the
//     link can still edit the open-edit doc, but not delete it.
//   - owned standalone doc → owner only.
//   - workspace doc → owner or workspace admin.
// Anonymous callers reach the decision (session optional); without a
// session on a non-anonymous doc the answer is 401.
// `deleteDocument` itself trusts its input (it's also called from the
// inactive-doc sweeper without a session).

export default defineApiHandler({
  access: allow.doc('delete', { anonymous: true, deny: 'docs/delete-forbidden' }),
  // Modest brake on anonymous-delete. Aligned with the token endpoint
  // (30/min) — deletes are rarer, so 10/min per client is plenty.
  rateLimit: { namespace: 'doc-delete', max: 10, windowMs: MINUTE_MS, key: 'ip' },
  handler: async ({ event, user, docId }) => {
    // Snapshot the row BEFORE the delete — once `deleteDocument` runs the
    // row is gone and we can't reconstruct title/accessMode for the audit
    // trail (`getDoc` returns the title field).
    const snapshot = await getDoc(docId)

    await deleteDocument(docId)

    // Audit AFTER the primary action commits. `appendAuditEvent` swallows
    // its own failures so a wedged audit table never flips a successful
    // delete into a 500.
    await appendAuditEvent({
      actorUserId: user?.id ?? null,
      actorIp: getClientIp(event),
      scope: 'doc',
      scopeId: docId,
      action: 'doc.deleted',
      workspaceId: snapshot?.workspaceId ?? null,
      before: snapshot
        ? {
            title: snapshot.title,
            accessMode: snapshot.accessMode,
            ownerId: snapshot.ownerId,
            workspaceId: snapshot.workspaceId
          }
        : null,
      after: null,
      metadata: { reason: 'user_initiated' }
    })
    return { success: true }
  }
})
