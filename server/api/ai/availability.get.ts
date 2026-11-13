import { availabilityFrom, resolveAiAccess } from '../../utils/aiProviders/resolve'
import { resolvePayingPlan } from '../../utils/billing/billing'
import { aiAvailabilityQuery } from '~~/shared/api/ai'

// GET /api/ai/availability: which AI capabilities the caller can use right now
// (own BYOK key, then instance default, else none) and whether each is
// platform-billed (consumes AI Points). Drives every AI entry point in the
// editor.
//
// `?workspaceId=` (the open document's workspace): inside a Team / Business
// workspace its plan decides which platform capabilities are unlocked; locked
// ones come back with `locked: 'plan'`.
export default defineApiHandler({
  access: allow.user(),
  query: aiAvailabilityQuery,
  handler: async ({ user, self, query }) => {
    const plan = await resolvePayingPlan(user.id, query.workspaceId ?? null)
    const access = await resolveAiAccess(self, plan)
    return availabilityFrom(access.providers, access)
  }
})
