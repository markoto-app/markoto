import { docExists, bumpLastActive } from '../../repos/documents'
import { normalizeAvatarSeed } from '../../../shared/utils/documents/awarenessUser'
import { appendActivity, pruneActivity, ACTIVITY_ACTIONS, type ActivityAction, type ActivityMetadata } from '../../repos/activity'
import { internalActivityBody } from '~~/shared/api/platform'

// Internal endpoint called by the sync-server to log user activity.
// Auth: X-Internal-Secret, enforced for all of /api/internal/** by
// server/middleware/auth.ts and again by the policy.

export default defineApiHandler({
  access: allow.internal('secret'),
  body: internalActivityBody,
  handler: async ({ body }) => {
    const action = body.action as ActivityAction
    if (!ACTIVITY_ACTIONS.includes(action)) throw apiError('request/invalid', { field: 'action' })

    // Anonymous/direct-URL docs without a DB row are skipped.
    if (!(await docExists(body.docId))) {
      return { success: true, logged: false }
    }

    const userId = typeof body.userId === 'number' ? body.userId : null
    const actorPrincipal = typeof body.actorPrincipal === 'string' && body.actorPrincipal.length > 0
      ? body.actorPrincipal
      : null
    const { inserted } = await appendActivity({
      docId: body.docId,
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
      metadata: (body.metadata ?? null) as ActivityMetadata | null,
      yjsDocIdBefore: typeof body.yjsDocIdBefore === 'number' ? body.yjsDocIdBefore : null,
      yjsDocIdAfter: typeof body.yjsDocIdAfter === 'number' ? body.yjsDocIdAfter : null
    })

    if (!inserted) {
      // Cross-instance dup or replay: `uq_activity_doc_yjsafter` makes the second
      // INSERT a no-op. Expected with several sync servers, so debug-level only.
      console.debug(`[activity] dedup skipped insert for doc=${body.docId} action=${action} yjsAfter=${body.yjsDocIdAfter}`)
      return { success: true, logged: false, deduped: true }
    }

    // Edit events bump `lastActive` (read by the inactive-doc sweep), so a doc
    // edited without ever hitting `meta.put` isn't reaped. Join/leave don't
    // count: a passive viewer shouldn't keep an abandoned doc alive.
    if (action === 'edit') {
      await bumpLastActive(body.docId)
    }

    // Cap the log at MAX_ENTRIES_PER_DOC (one count + one targeted delete).
    await pruneActivity(body.docId)

    return { success: true, logged: true }
  }
})
