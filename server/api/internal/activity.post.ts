import { requireInternalSecret } from '../../utils/platform/internalRoutes'
import { docExists, bumpLastActive } from '../../repos/documents'
import { normalizeAvatarSeed } from '../../../shared/utils/documents/awarenessUser'
import { appendActivity, pruneActivity, ACTIVITY_ACTIONS, type ActivityAction, type ActivityMetadata } from '../../repos/activity'

// Internal endpoint called by the sync-server to log user activity.
// Auth: X-Internal-Secret, enforced for all of /api/internal/** by
// server/middleware/auth.ts; repeated here so the handler is safe on its own.

export default defineEventHandler(async (event) => {
  requireInternalSecret(event)

  const body = await readBody<{
    docId?: string
    userId?: number | null
    userName?: string | null
    actorPrincipal?: string | null
    actorAvatarSeed?: string | null
    action?: ActivityAction
    wordCount?: number | null
    linesAdded?: number | null
    linesRemoved?: number | null
    metadata?: ActivityMetadata | null
    yjsDocIdBefore?: number | null
    yjsDocIdAfter?: number | null
  }>(event)

  if (!body.docId || typeof body.docId !== 'string') {
    throw createError({ statusCode: 400, message: 'Missing docId' })
  }
  if (!body.action || !ACTIVITY_ACTIONS.includes(body.action)) {
    throw createError({ statusCode: 400, message: 'Invalid action' })
  }

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
    action: body.action,
    wordCount: body.wordCount ?? null,
    linesAdded: body.linesAdded ?? null,
    linesRemoved: body.linesRemoved ?? null,
    metadata: body.metadata ?? null,
    yjsDocIdBefore: typeof body.yjsDocIdBefore === 'number' ? body.yjsDocIdBefore : null,
    yjsDocIdAfter: typeof body.yjsDocIdAfter === 'number' ? body.yjsDocIdAfter : null
  })

  if (!inserted) {
    // Cross-instance dup or replay: `uq_activity_doc_yjsafter` makes the second
    // INSERT a no-op. Expected with several sync servers, so debug-level only.
    console.debug(`[activity] dedup skipped insert for doc=${body.docId} action=${body.action} yjsAfter=${body.yjsDocIdAfter}`)
    return { success: true, logged: false, deduped: true }
  }

  // Edit events bump `lastActive` (read by the inactive-doc sweep), so a doc
  // edited without ever hitting `meta.put` isn't reaped. Join/leave don't
  // count: a passive viewer shouldn't keep an abandoned doc alive.
  if (body.action === 'edit') {
    await bumpLastActive(body.docId)
  }

  // Cap the log at MAX_ENTRIES_PER_DOC (one count + one targeted delete).
  await pruneActivity(body.docId)

  return { success: true, logged: true }
})
