import { system } from '../../repos/proofs'
import { normalizeAvatarSeed } from '../../../shared/utils/documents/awarenessUser'
import { recordActivity } from '../../repos/activity'
import { internalActivityBody } from '~~/shared/api/platform'
import { useLogger } from '../../utils/platform/logger'

const log = useLogger('activity')

// Internal endpoint called by the sync-server to log user activity.
// Auth: X-Internal-Secret, enforced for all of /api/internal/** by
// server/middleware/auth.ts and again by the policy.

export default defineApiHandler({
  access: allow.internal('secret'),
  body: internalActivityBody,
  handler: async ({ body }) => {
    const action = body.action
    const userId = typeof body.userId === 'number' ? body.userId : null
    const actorPrincipal = typeof body.actorPrincipal === 'string' && body.actorPrincipal.length > 0
      ? body.actorPrincipal
      : null
    // The sync server reports what its authorised clients did to this document.
    const doc = system('sync-server').doc(body.docId)
    // One statement (repos/activity.ts): this runs once per stored change of
    // every open document. It also:
    //   - skips documents without a row (anonymous / direct-URL docs);
    //   - bumps `lastActive` on edits (read by the inactive-doc sweep), so a
    //     doc edited without ever hitting `meta.put` isn't reaped. Join/leave
    //     don't count: a passive viewer shouldn't keep an abandoned doc alive;
    //   - caps the log at its per-document maximum.
    const result = await recordActivity(doc, {
      userId,
      userName: body.userName || null,
      actorPrincipal,
      // Only an anonymous editor's row carries an avatar token (signed-in
      // users are seeded by id, agents use the seal).
      actorAvatarSeed: userId === null && (actorPrincipal === null || actorPrincipal === 'anonymous')
        ? normalizeAvatarSeed(body.actorAvatarSeed)
        : null,
      action,
      wordCount: body.wordCount ?? null,
      linesAdded: body.linesAdded ?? null,
      linesRemoved: body.linesRemoved ?? null,
      metadata: body.metadata ?? null,
      yjsDocIdBefore: typeof body.yjsDocIdBefore === 'number' ? body.yjsDocIdBefore : null,
      yjsDocIdAfter: typeof body.yjsDocIdAfter === 'number' ? body.yjsDocIdAfter : null
    }, { bumpLastActive: action === 'edit' })

    if (result === 'no-doc') {
      return { success: true, logged: false }
    }
    if (result === 'deduped') {
      // Cross-instance dup or replay: `uq_activity_doc_yjsafter` makes the second
      // INSERT a no-op. Expected with several sync servers, so debug-level only.
      log.debug('dedup skipped insert', { docId: body.docId, action, yjsDocIdAfter: body.yjsDocIdAfter })
      return { success: true, logged: false, deduped: true }
    }
    return { success: true, logged: true }
  }
})
