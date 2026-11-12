import { getActivityById } from '../../../../../repos/activity'
import { assertWithinHistory, resolveDocPlanFor } from '../../../../../utils/billing/entitlements'
import { reconstructTextAtYjsId } from '../../../../../utils/documents/historyReplay'
import { YjsHistoryCompactedError } from '../../../../../utils/documents/yjsLog'
import { computeTextDiff, type DiffHunk } from '../../../../../utils/documents/textDiff'
import { activityParams } from '~~/shared/api/docs'

// On-demand text diff for a single activity row: replays the doc on either
// side of the row's yjs_doc_id boundaries and returns a structured diff.
//
// Access mirrors the parent activity GET:
//   - open-edit / open-view: public
//   - private / password-protected: owner, workspace member, or holder of a
//     valid doc-scoped JWT (anon users who verified a password)
//
// Errors:
//   - 404 row doesn't exist OR belongs to another doc (the row id alone is
//     not a capability)
//   - 410 row has no boundary ids (yjsDocIdAfter is null), or its Y.js
//     history was pruned (below the history floor); the UI shows
//     "diff unavailable"
//   - 403 actor can't read activity for this doc
//
// Response: { before, after, hunks: DiffHunk[], truncated, totalHunks }.
// computeTextDiff caps hunks (200) and line length (2000 chars), which keeps
// the response around 500KB at most.

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

export default defineApiHandler({
  access: allow.doc('activity', { anonymous: true, jwt: true }),
  params: activityParams,
  handler: async ({ docId, doc: docRow, params: { activityId } }): Promise<DiffResponse> => {
    const activity = await getActivityById(activityId, docId)
    if (!activity) {
      throw apiError('docs/activity-not-found')
    }
    // Rows older than the document's plan history window stay stored but
    // can't be opened (409 `plan/limit-reached`, field `historyDays`).
    assertWithinHistory(await resolveDocPlanFor(docRow), activity.createdAt)

    // Rows without boundary ids can't be diffed. 410: exists but permanently
    // unavailable.
    if (activity.yjsDocIdAfter === null) {
      throw apiError('docs/diff-unavailable')
    }

    // `before` is null on the very first edit; reconstructTextAtYjsId returns
    // '' for null / negative ids.
    let before: string
    let after: string
    try {
      [before, after] = await Promise.all([
        reconstructTextAtYjsId(docId, activity.yjsDocIdBefore),
        reconstructTextAtYjsId(docId, activity.yjsDocIdAfter)
      ])
    } catch (e) {
      // The sync server pruned the history this row points into.
      if (e instanceof YjsHistoryCompactedError) throw apiError('docs/diff-unavailable')
      throw e
    }

    const { hunks, truncated, totalHunks } = computeTextDiff(before, after)

    return {
      activityId: activity.id,
      before,
      after,
      hunks,
      truncated,
      totalHunks
    }
  }
})
