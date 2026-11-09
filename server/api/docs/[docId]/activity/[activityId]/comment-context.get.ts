import { getDocWithActorRole } from '../../../../../repos/documents'
import { getActivityById } from '../../../../../repos/activity'
import { assertWithinHistory, resolveDocPlanFor } from '../../../../../utils/entitlements'
import { getCommentThreadByEntryId } from '../../../../../repos/comments'
import { decideActivityAccess, type DocState, type ActorState } from '../../../../../../shared/utils/docPermissions'
import { hasValidDocJwt } from '../../../../../utils/docTokenVerify'

// On-demand fetch of the full conversation thread for a comment-row
// activity. The activity row stores only a body preview — when the
// user expands the row, we want the full body PLUS the surrounding
// reply chain so they can see the conversation context this row
// belonged to.
//
// Source-of-truth: the `document_comments` mirror table. The mirror
// is eventually-consistent (lags Y.js by a few seconds) but the
// activity row that triggered this expansion was itself created from
// a snapshot push, so by the time the user clicks "View thread" the
// mirror has caught up.
//
// Endpoint shape:
//   GET /api/docs/:docId/activity/:activityId/comment-context
//   → 200 { rows: CommentThreadRow[], focusEntryId: string }
//   → 404 if the activity row doesn't exist for this doc
//   → 410 if the row is a comment.* event but the entry has been
//        purged from the mirror (deleted thread + post-snapshot prune)
//   → 410 if the row isn't a comment.* event at all (caller bug)
//   → 403 if the actor isn't allowed to read activity for this doc

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

export default defineEventHandler(async (event): Promise<CommentContextResponse> => {
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

  const doc: DocState = {
    ownerId: docRow.ownerId,
    workspaceId: docRow.workspaceId,
    accessMode: docRow.accessMode
  }
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
  if (!COMMENT_ACTIONS.has(activity.action)) {
    throw createError({ statusCode: 410, message: 'Activity row is not a comment event' })
  }

  // Pull the entry id off the metadata. All comment.* shapes carry
  // a `commentId` field; defensive in case some old row was written
  // before that contract was tightened.
  const meta = activity.metadata as { kind?: string, commentId?: string } | null
  const entryId = meta?.commentId
  if (!entryId) {
    throw createError({ statusCode: 410, message: 'Activity row has no commentId in metadata' })
  }

  const thread = await getCommentThreadByEntryId(docId, entryId)
  if (!thread || thread.length === 0) {
    // Comment was deleted after the activity row was written. We
    // still know which entry the row referred to, but there's no
    // thread context to render. The UI surfaces this as "thread no
    // longer exists" — better than 404 because the activity row
    // itself is real, just orphaned.
    throw createError({
      statusCode: 410,
      statusMessage: 'Comment thread no longer exists',
      message: 'The comment this row referred to has been deleted.'
    })
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
})
