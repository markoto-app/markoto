import { getDoc, getDocWithActorRole } from '../../../repos/documents'
import { deleteDocument } from '../../../utils/documents/documentLifecycle'
import { appendAuditEvent } from '../../../repos/audit'
import { anonCreatorKeyMatches, readAnonCreatorKey } from '../../../utils/auth/anonCreator'
import { docStateOf, decideDocDelete, type DocState, type ActorState } from '../../../../shared/utils/documents/docPermissions'

// Delete a document. Authorisation is decided by `decideDocDelete`:
//   - anonymous doc (no owner, no workspace) → only the browser that
//     created it, proven by the httpOnly creator-key cookie whose hash
//     is stored on the row (`utils/anonCreator.ts`). Others with the
//     link can still edit the open-edit doc, but not delete it.
//   - owned standalone doc → owner only.
//   - workspace doc → owner or workspace admin.
// `deleteDocument` itself trusts its input (it's also called from the
// inactive-doc sweeper without a session).

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)

  // Modest brake on anonymous-delete. Aligned with the token endpoint
  // (30/min) — deletes are rarer, so 10/min per IP is plenty.
  const ip = getClientRateLimitKey(event)
  if (!(await checkRateLimit('doc-delete', ip, 10, 60_000))) {
    throw createError({ statusCode: 429, message: 'Too many delete requests. Try again later.' })
  }

  // Session is optional — anon can reach this endpoint to delete an
  // anon doc. `getValidatedUserSession` still clears stale cookies as
  // a side effect, which is fine.
  const session = await getValidatedUserSession(event)
  const row = await getDocWithActorRole(docId, session?.user?.id ?? null)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  const doc: DocState = docStateOf(row)
  const actor: ActorState = {
    userId: session?.user?.id ?? null,
    workspaceRole: row.workspaceRole,
    isAnonCreator: anonCreatorKeyMatches(readAnonCreatorKey(event), row.anonCreatorKeyHash)
  }

  const decision = decideDocDelete(doc, actor)
  if (decision.outcome === 'deny') {
    if (decision.reason === 'authentication-required') {
      throw createError({ statusCode: 401, message: 'Login required' })
    }
    throw createError({ statusCode: 403, message: 'Not authorized to delete this document' })
  }

  // Snapshot the row BEFORE the delete — once `deleteDocument` runs the
  // row is gone and we can't reconstruct title/accessMode for the audit
  // trail. Cheap re-read; cross-checked against `row` already loaded
  // above (we use this one because `getDoc` returns the title field).
  const snapshot = await getDoc(docId)

  await deleteDocument(docId)

  // Audit AFTER the primary action commits. `appendAuditEvent` swallows
  // its own failures so a wedged audit table never flips a successful
  // delete into a 500.
  await appendAuditEvent({
    actorUserId: session?.user?.id ?? null,
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
})
