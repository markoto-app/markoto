import { availabilityFrom, resolveAiAccess } from '../../utils/aiProviders/resolve'
import { resolvePayingPlan } from '../../utils/billing/billing'

// GET /api/ai/availability: which AI capabilities the caller can use right now
// (own BYOK key, then instance default, else none) and whether each is
// platform-billed (consumes AI Points). Drives every AI entry point in the
// editor.
//
// `?workspaceId=` (the open document's workspace): inside a Team / Business
// workspace its plan decides which platform capabilities are unlocked; locked
// ones come back with `locked: 'plan'`.
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const q = getQuery(event)
  const workspaceId = typeof q.workspaceId === 'string' && q.workspaceId.length <= 64 ? q.workspaceId : null
  const plan = await resolvePayingPlan(session.user.id, workspaceId)
  const access = await resolveAiAccess(session.user.id, plan)
  return availabilityFrom(access.providers, access)
})
