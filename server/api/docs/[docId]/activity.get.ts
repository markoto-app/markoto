import { getDocWithActorRole } from '../../../repos/documents'
import { hasActivityBefore, listRecentActivity } from '../../../repos/activity'
import { HISTORY_LIMITED_HEADER, capsFor, historyCutoff, resolveDocPlanFor } from '../../../utils/billing/entitlements'
import { docStateOf, decideActivityAccess, type DocState, type ActorState } from '../../../../shared/utils/documents/docPermissions'
import { hasValidDocJwt } from '../../../utils/documents/docTokenVerify'

// Activity log is a view-level read; access rules mirror file access:
//   - open-edit / open-view: public.
//   - private / password-protected: owner, workspace member, or holder of a
//     valid doc-scoped JWT (anon users who verified a password).

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)
  const session = await getValidatedUserSession(event)

  const row = await getDocWithActorRole(docId, session?.user?.id ?? null)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  const doc: DocState = docStateOf(row)
  const actor: ActorState = {
    userId: session?.user?.id ?? null,
    workspaceRole: row.workspaceRole,
    hasValidDocJwt: hasValidDocJwt(event, docId)
  }

  const decision = decideActivityAccess(doc, actor)
  if (decision.outcome === 'deny') {
    throw createError({ statusCode: 403, message: 'Access denied' })
  }

  // The plan may limit how far back history goes (`historyDays`). Older rows
  // stay stored; the header tells the UI some are hidden.
  const plan = await resolveDocPlanFor({ ownerId: row.ownerId, workspaceId: row.workspaceId })
  const cutoff = historyCutoff(plan)
  if (cutoff && await hasActivityBefore(docId, cutoff)) {
    setResponseHeader(event, HISTORY_LIMITED_HEADER, String(capsFor(plan).historyDays))
  }
  return listRecentActivity(docId, 50, cutoff)
})
