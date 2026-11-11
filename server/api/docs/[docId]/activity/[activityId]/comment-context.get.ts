import { getActivityById } from '../../../../../repos/activity'
import { assertWithinHistory, resolveDocPlanFor } from '../../../../../utils/billing/entitlements'
import { getCommentThreadByEntryId } from '../../../../../repos/comments'
import { activityParams } from '~~/shared/api/docs'

// On-demand fetch of the full conversation thread for a comment activity
// row. The row stores only a body preview; expanding it needs the full body
// plus the surrounding reply chain.
//
// Source of truth is the `document_comments` mirror table. It lags Y.js by a
// few seconds, but the activity row was created from a snapshot push, so the
// mirror has caught up by the time the user expands it.
//
//   GET /api/docs/:docId/activity/:activityId/comment-context
//   200 { rows: CommentThreadRow[], focusEntryId: string }
//   404 activity row doesn't exist for this doc
//   410 comment.* row whose entry was purged from the mirror, or a row that
//       isn't a comment.* event at all
//   403 actor can't read activity for this doc

interface CommentContextRow {
  entryId: string
  parentCommentId: string | null
  authorId: number | null
  authorName: string
  body: string
  createdAtMs: number
  updatedAtMs: number
  resolved: boolean
}

interface CommentContextResponse {
  /** The activity row the response was computed for. */
  activityId: number
  /** Comments in chronological order — root first, then replies. */
  rows: CommentContextRow[]
  /** Which entry the activity row was about (for highlight rendering). */
  focusEntryId: string
}

const COMMENT_ACTIONS = new Set([
  'comment.added',
  'comment.replied',
  'comment.resolved',
  'comment.reopened',
  'comment.deleted'
])

export default defineApiHandler({
  access: allow.doc('activity', { anonymous: true, jwt: true }),
  params: activityParams,
  handler: async ({ docId, doc: docRow, params: { activityId } }): Promise<CommentContextResponse> => {
    const activity = await getActivityById(activityId, docId)
    if (!activity) {
      throw apiError('docs/activity-not-found')
    }
    // Rows older than the document's plan history window stay stored but
    // can't be opened (409 `plan/limit-reached`, field `historyDays`).
    assertWithinHistory(await resolveDocPlanFor(docRow), activity.createdAt)
    if (!COMMENT_ACTIONS.has(activity.action)) {
      throw apiError('docs/not-a-comment')
    }

    // All comment.* metadata shapes carry `commentId`; guard against rows
    // written without it.
    const meta = activity.metadata as { kind?: string, commentId?: string } | null
    const entryId = meta?.commentId
    if (!entryId) {
      throw apiError('docs/not-a-comment')
    }

    const thread = await getCommentThreadByEntryId(docId, entryId)
    if (!thread || thread.length === 0) {
      // Comment was deleted after the row was written. 410 rather than 404
      // because the activity row itself is real, just orphaned; the UI shows
      // "thread no longer exists".
      throw apiError('docs/comment-thread-gone')
    }

    return {
      activityId: activity.id,
      rows: thread.map(r => ({
        entryId: r.entryId,
        parentCommentId: r.parentCommentId,
        authorId: r.authorId,
        authorName: r.authorName,
        body: r.body,
        createdAtMs: r.createdAt.getTime(),
        updatedAtMs: r.updatedAt.getTime(),
        resolved: r.resolved
      })),
      focusEntryId: entryId
    }
  }
})
