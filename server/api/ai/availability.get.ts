import { availabilityFrom, resolveAiAccess } from '../../utils/aiProviders/resolve'
import { resolvePayingPlan } from '../../utils/billing/billing'

// GET /api/ai/availability — which AI capabilities the caller can use
// right now (own BYOK key → instance default → none), and whether each
// one is platform-billed (consumes AI Points). Drives every AI entry
// point in the editor: prompt bar / @ai / voice show a "Add your API key
// in Settings" call-to-action or hide themselves accordingly, and the
// AI Points meter only shows when something is platform-billed.

// `?workspaceId=` (the open document's workspace): inside a Team /
// Business workspace its plan decides which platform capabilities are
// unlocked (WP5); locked ones come back with `locked: 'plan'`.
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const q = getQuery(event)
  const workspaceId = typeof q.workspaceId === 'string' && q.workspaceId.length <= 64 ? q.workspaceId : null
  const plan = await resolvePayingPlan(session.user.id, workspaceId)
  const access = await resolveAiAccess(session.user.id, plan)
  return availabilityFrom(access.providers, access)
})
