import { availabilityFrom, resolveAiProviders } from '../../utils/aiProviders/resolve'

// GET /api/ai/availability — which AI capabilities the caller can use
// right now (own BYOK key → instance default → none), and whether each
// one is platform-billed (consumes AI Points). Drives every AI entry
// point in the editor: prompt bar / @ai / voice show a "Add your API key
// in Settings" call-to-action or hide themselves accordingly, and the
// AI Points meter only shows when something is platform-billed.

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  return availabilityFrom(await resolveAiProviders(session.user.id))
})
