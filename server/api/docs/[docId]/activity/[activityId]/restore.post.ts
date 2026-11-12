import { nanoid } from 'nanoid'
import { getActivityById, appendActivity, pruneActivity } from '../../../../../repos/activity'
import { restoreDocToYjsId, RestorePointCompactedError } from '../../../../../utils/documents/restoreDoc'
import { findUserName } from '../../../../../repos/users'
import { assertWithinHistory, resolveDocPlan } from '../../../../../utils/billing/entitlements'
import { activityParams } from '~~/shared/api/docs'
import { useLogger } from '../../../../../utils/platform/logger'

const log = useLogger('restore')

// POST /api/docs/:docId/activity/:activityId/restore
//
// Snap the live Y.Doc back to the state at this activity row's
// yjsDocIdBefore (rows describe a change FROM `before` TO `after`, so undoing
// it means restoring `before`).
//
// The restore is a real Y.js operation broadcast to every connected client,
// not a history rewrite: the Y.js log (`yjs_updates`) keeps every state, and the
// resulting `restore` row is itself reversible.
//
// Auth: edit access (matches `replace_text` / `set_title`). Viewers can see
// diffs but not apply them.
//
// Errors:
//   - 401: unauthenticated
//   - 403: viewer / non-member on a private doc
//   - 404: unknown activityId, or activity row belongs to a different
//          doc (cross-doc leak guard)
//   - 410: activity row predates boundary tracking (yjsDocIdBefore null)
//   - 500: replay or sync failure — doc state unchanged

export default defineApiHandler({
  // Edit access: owner, workspace admin / editor, or anyone on an open-edit
  // doc except a workspace viewer (`canWriteDocContent`, as the editor's token).
  access: allow.doc('write-content', { deny: 'docs/edit-forbidden' }),
  params: activityParams,
  body: 'none',
  handler: async ({ user, self, docId, docAccess, params: { activityId } }) => {
    const userId = user.id

    // The (id, docId) tuple in `getActivityById` pins the row to THIS doc; a
    // row from another doc yields null -> 404 (same as the diff endpoint).
    const activity = await getActivityById(docAccess, activityId)
    if (!activity) {
      throw apiError('docs/activity-not-found')
    }
    assertWithinHistory(await resolveDocPlan(docId), activity.createdAt)
    if (activity.yjsDocIdBefore === null) {
      throw apiError('docs/restore-unavailable')
    }

    // Display name for the awareness label shown while the restore
    // broadcasts; falls back to "User" if the user record is missing.
    const actorName = (await findUserName(self)) ?? 'User'

    // Synthetic session id namespacing the JWT principal and the Y.js
    // transaction origin; only needs to be unique per in-flight restore
    // (concurrent restores serialize via the advisory lock).
    const sessionId = nanoid(12)

    let yjsDocIdBeforeRestore: number | null
    let yjsDocIdAfterRestore: number | null
    try {
      const result = await restoreDocToYjsId({
        doc: docAccess,
        targetYjsId: activity.yjsDocIdBefore,
        actorUserId: userId,
        actorName,
        sessionId
      })
      yjsDocIdBeforeRestore = result.yjsDocIdBeforeRestore
      yjsDocIdAfterRestore = result.yjsDocIdAfterRestore
    } catch (e) {
      // Target compacted away: the live doc is untouched (refused before the
      // apply). 410, not a retryable 500: retrying can't bring merged-away
      // history back.
      if (e instanceof RestorePointCompactedError) {
        throw apiError('docs/restore-compacted')
      }
      // The Y.js transaction is atomic: on failure the live doc is unchanged.
      // 500 so the client can retry.
      log.error('restore failed', { docId, activityId, err: e })
      throw apiError('internal', undefined, { cause: e })
    }

    // Boundary ids of the `restore` row: `yjsDocIdBefore` is the live state
    // right before the restore (this is what makes restoring THIS row bring the
    // pre-restore state back), `yjsDocIdAfter` the post-restore state.
    await appendActivity(docAccess, {
      userId,
      userName: actorName,
      action: 'restore',
      metadata: {
        kind: 'restore',
        restoredFromActivityId: activity.id,
        restoredFromTime: activity.createdAt.toISOString()
      },
      yjsDocIdBefore: yjsDocIdBeforeRestore,
      yjsDocIdAfter: yjsDocIdAfterRestore
    })
    await pruneActivity(docAccess)

    return {
      ok: true,
      restoredFromActivityId: activity.id,
      restoredFromTime: activity.createdAt.toISOString()
    }
  }
})
