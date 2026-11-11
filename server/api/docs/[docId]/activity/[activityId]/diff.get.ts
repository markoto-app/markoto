import { getDocWithActorRole } from '../../../../../repos/documents'
import { getActivityById } from '../../../../../repos/activity'
import { assertWithinHistory, resolveDocPlanFor } from '../../../../../utils/billing/entitlements'
import { docStateOf, decideActivityAccess, type DocState, type ActorState } from '../../../../../../shared/utils/documents/docPermissions'
import { hasValidDocJwt } from '../../../../../utils/documents/docTokenVerify'
import { reconstructTextAtYjsId } from '../../../../../utils/documents/historyReplay'
import { computeTextDiff, type DiffHunk } from '../../../../../utils/documents/textDiff'

// On-demand text diff for a single activity row. Called from the
// activity-feed UI when the user expands a card. Replays the doc on
// either side of the row's yjs_doc_id boundaries and returns a
// structured unified diff.
//
// Auth gates mirror the parent activity GET:
//   - open-edit / open-view → public
//   - private / password-protected → owner, workspace member, or
//     holder of a valid doc-scoped JWT (covers anon users who
//     verified a password)
//
// Errors:
//   - 404 if the activity row doesn't exist OR doesn't belong to the
//     requested doc (defensive — the row id alone isn't a capability)
//   - 410 if the row predates the boundary-tracking feature
//     (yjsDocIdAfter is null). The UI renders a "diff unavailable
//     for this row" message — historic data not feature breakage.
//   - 403 if the actor isn't allowed to read activity for this doc
//
// Response is a structured diff object the UI renders directly:
//   { before, after, hunks: DiffHunk[], truncated, totalHunks }
// Body lengths are capped inside computeTextDiff (200 hunks max,
// 2000 chars per line). Total response should comfortably stay
// under ~500KB for any realistic edit.

interface DiffResponse {
  /** The activity row id this diff was computed for. */
  activityId: number
  /** Plain text BEFORE the change. May be empty (edit was the first write). */
  before: string
  /** Plain text AFTER the change. Always reflects the doc at the row's
   *  yjs_doc_id_after; this matches what the doc looked like
   *  immediately after the store event that produced the row. */
  after: string
  hunks: DiffHunk[]
  /** True when the diff was capped at MAX_HUNKS. UI shows a banner. */
  truncated: boolean
  /** Total hunks before capping (so UI can render "showing X of Y"). */
  totalHunks: number
}

export default defineEventHandler(async (event): Promise<DiffResponse> => {
  const docId = requireDocId(event)
  const activityId = Number(getRouterParam(event, 'activityId'))
  if (!Number.isInteger(activityId) || activityId <= 0) {
    throw createError({ statusCode: 400, message: 'Invalid activityId' })
  }

  const session = await getValidatedUserSession(event)

  const docRow = await getDocWithActorRole(docId, session?.user?.id ?? null)
  if (!docRow) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  const doc: DocState = docStateOf(docRow)
  const actor: ActorState = {
    userId: session?.user?.id ?? null,
    workspaceRole: docRow.workspaceRole,
    hasValidDocJwt: hasValidDocJwt(event, docId)
  }
  if (decideActivityAccess(doc, actor).outcome === 'deny') {
    throw createError({ statusCode: 403, message: 'Access denied' })
  }

  const activity = await getActivityById(activityId, docId)
  if (!activity) {
    throw createError({ statusCode: 404, message: 'Activity row not found' })
  }
  // Rows older than the document's plan history window stay stored but
  // can't be opened (409 `plan/limit-reached`, field `historyDays`).
  assertWithinHistory(await resolveDocPlanFor(docRow), activity.createdAt)

  // Boundary check: rows from before this feature have neither id; we
  // can't compute a diff retrospectively (the snapshot is gone if
  // y-postgresql merged through it). 410 = "this resource exists but
  // is permanently unavailable for this representation."
  if (activity.yjsDocIdAfter === null) {
    throw createError({
      statusCode: 410,
      statusMessage: 'Diff unavailable',
      message: 'This activity row was recorded before diff tracking was enabled.'
    })
  }

  // `before` may legitimately be null on the very first edit ever
  // (no prior y-postgresql rows) — reconstructTextAtYjsId handles
  // null / negative ids by returning ''.
  const [before, after] = await Promise.all([
    reconstructTextAtYjsId(docId, activity.yjsDocIdBefore),
    reconstructTextAtYjsId(docId, activity.yjsDocIdAfter)
  ])

  const { hunks, truncated, totalHunks } = computeTextDiff(before, after)

  return {
    activityId: activity.id,
    before,
    after,
    hunks,
    truncated,
    totalHunks
  }
})
