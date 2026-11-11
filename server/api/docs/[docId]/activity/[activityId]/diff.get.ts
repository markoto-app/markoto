import { getDocWithActorRole } from '../../../../../repos/documents'
import { getActivityById } from '../../../../../repos/activity'
import { assertWithinHistory, resolveDocPlanFor } from '../../../../../utils/billing/entitlements'
import { docStateOf, decideActivityAccess, type DocState, type ActorState } from '../../../../../../shared/utils/documents/docPermissions'
import { hasValidDocJwt } from '../../../../../utils/documents/docTokenVerify'
import { reconstructTextAtYjsId } from '../../../../../utils/documents/historyReplay'
import { computeTextDiff, type DiffHunk } from '../../../../../utils/documents/textDiff'

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
//   - 410 row has no boundary ids (yjsDocIdAfter is null); the UI shows
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

  // Rows without boundary ids can't be diffed (the snapshot is gone if
  // y-postgresql merged through it). 410: exists but permanently unavailable.
  if (activity.yjsDocIdAfter === null) {
    throw createError({
      statusCode: 410,
      statusMessage: 'Diff unavailable',
      message: 'This activity row was recorded before diff tracking was enabled.'
    })
  }

  // `before` is null on the very first edit; reconstructTextAtYjsId returns
  // '' for null / negative ids.
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
