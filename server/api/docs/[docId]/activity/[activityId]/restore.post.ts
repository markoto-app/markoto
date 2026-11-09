import { nanoid } from 'nanoid'
import { requireDocEditAccess } from '../../../../../utils/documentAccess'
import { getActivityById, appendActivity, pruneActivity } from '../../../../../repos/activity'
import { restoreDocToYjsId, RestorePointCompactedError } from '../../../../../utils/restoreDoc'
import { findUserNameById } from '../../../../../repos/users'
import { assertWithinHistory, resolveDocPlan } from '../../../../../utils/entitlements'

// POST /api/docs/:docId/activity/:activityId/restore
//
// Snap the live Y.Doc back to the state at this activity row's
// yjsDocIdBefore. The "before" boundary is the right anchor because
// activity rows describe a change FROM the state at `before` TO the
// state at `after` — to undo the change, we want the `before` state.
//
// The restore is a real Y.js operation that broadcasts to every
// connected client. It's NOT a destructive history rewrite —
// y-postgresql keeps the operation log untouched, and the resulting
// `restore` activity row is itself reversible (clicking restore on
// IT brings the doc back to the pre-restore state).
//
// Auth: requires edit access (matches `replace_text` / `set_title`).
// Read-only viewers can SEE diffs (Tier 1) but can't APPLY them.
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

  // The activity row must belong to THIS doc — pinned via the (id, docId)
  // tuple in `getActivityById`. A row id from a different doc returns
  // null, which we surface as 404 (matches the diff endpoint's pattern).
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

  // Resolve the actor's display name for the awareness label
  // collaborators see when the restore broadcasts. Fall back to a
  // generic label if the user record is missing — the restore still
  // happens, the awareness ribbon just shows "User" instead of name.
  const actorName = (await findUserNameById(userId)) ?? 'User'

  // Synthetic session id namespaces the JWT principal AND the Y.js
  // transaction origin. Short — only needs to be unique per in-flight
  // restore; concurrent restores serialize via the advisory lock.
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
    // Target compacted away (F4) — the live doc is untouched (we refuse
    // BEFORE the apply). Surface as 410 Gone with a clear message, NOT a
    // retryable 500: retrying won't bring the merged-away history back.
    if (e instanceof RestorePointCompactedError) {
      throw createError({
        statusCode: 410,
        statusMessage: 'Restore unavailable',
        message: 'This restore point is too old — its history has been compacted and can no longer be restored. Restore to a more recent point instead.'
      })
    }
    // The Y.js transaction is atomic — on any failure inside
    // restoreDocToYjsId, the live doc is unchanged. Surface as 500
    // so the client retries via UI affordance. Log the underlying
    // cause for debugging.
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[restore] failed for doc=${docId} activity=${activityId}: ${msg}`)
    throw createError({
      statusCode: 500,
      statusMessage: 'Restore failed',
      message: 'The restore could not complete. The document is unchanged. Please try again.'
    })
  }

  // Write the `restore` activity row. Boundary ids:
  //   - `yjsDocIdBefore` = the LIVE state right before the restore.
  //     This is what powers reversibility — clicking restore on
  //     this new row brings the doc back to the pre-restore state.
  //   - `yjsDocIdAfter`  = the post-restore state.
  // The diff drawer then renders "live before → past target" as
  // the user-visible change, and the future-restore semantics
  // ("restore THIS restore") snap the doc back to the captured
  // pre-restore live state.
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
