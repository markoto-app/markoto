import { nanoid } from 'nanoid'
import { requireDocEditAccess } from '../../../../../utils/documents/documentAccess'
import { getActivityById, appendActivity, pruneActivity } from '../../../../../repos/activity'
import { restoreDocToYjsId, RestorePointCompactedError } from '../../../../../utils/documents/restoreDoc'
import { findUserNameById } from '../../../../../repos/users'
import { assertWithinHistory, resolveDocPlan } from '../../../../../utils/billing/entitlements'

// POST /api/docs/:docId/activity/:activityId/restore
//
// Snap the live Y.Doc back to the state at this activity row's
// yjsDocIdBefore (rows describe a change FROM `before` TO `after`, so undoing
// it means restoring `before`).
//
// The restore is a real Y.js operation broadcast to every connected client,
// not a history rewrite: y-postgresql keeps the operation log, and the
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

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)
  const activityId = Number(getRouterParam(event, 'activityId'))
  if (!Number.isInteger(activityId) || activityId <= 0) {
    throw createError({ statusCode: 400, message: 'Invalid activityId' })
  }

  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  // Edit access gate — uses the standard helper that handles owner +
  // workspace-admin/editor branches + raises 403/404 internally.
  await requireDocEditAccess(docId, userId)

  // The (id, docId) tuple in `getActivityById` pins the row to THIS doc; a
  // row from another doc yields null -> 404 (same as the diff endpoint).
  const activity = await getActivityById(activityId, docId)
  if (!activity) {
    throw createError({ statusCode: 404, message: 'Activity row not found' })
  }
  assertWithinHistory(await resolveDocPlan(docId), activity.createdAt)
  if (activity.yjsDocIdBefore === null) {
    throw createError({
      statusCode: 410,
      statusMessage: 'Restore unavailable',
      message: 'This activity row was recorded before restore tracking was enabled.'
    })
  }

  // Display name for the awareness label shown while the restore
  // broadcasts; falls back to "User" if the user record is missing.
  const actorName = (await findUserNameById(userId)) ?? 'User'

  // Synthetic session id namespacing the JWT principal and the Y.js
  // transaction origin; only needs to be unique per in-flight restore
  // (concurrent restores serialize via the advisory lock).
  const sessionId = nanoid(12)

  let yjsDocIdBeforeRestore: number | null
  let yjsDocIdAfterRestore: number | null
  try {
    const result = await restoreDocToYjsId({
      docId,
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
      throw createError({
        statusCode: 410,
        statusMessage: 'Restore unavailable',
        message: 'This restore point is too old — its history has been compacted and can no longer be restored. Restore to a more recent point instead.'
      })
    }
    // The Y.js transaction is atomic: on failure the live doc is unchanged.
    // 500 so the client can retry.
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[restore] failed for doc=${docId} activity=${activityId}: ${msg}`)
    throw createError({
      statusCode: 500,
      statusMessage: 'Restore failed',
      message: 'The restore could not complete. The document is unchanged. Please try again.'
    })
  }

  // Boundary ids of the `restore` row: `yjsDocIdBefore` is the live state
  // right before the restore (this is what makes restoring THIS row bring the
  // pre-restore state back), `yjsDocIdAfter` the post-restore state.
  await appendActivity({
    docId,
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
  await pruneActivity(docId)

  return {
    ok: true,
    restoredFromActivityId: activity.id,
    restoredFromTime: activity.createdAt.toISOString()
  }
})
