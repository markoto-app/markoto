import { answerSessionConfirmation, readSessionChannel } from '../../../../utils/agentic/sessionChannel'
import { aiSessionParams, confirmAiSessionBody } from '~~/shared/api/ai'

// POST /api/ai/sessions/:sessionId/confirm { confirmationId, allow, note? }
//
// The initiator's answer to a confirmation raised by the taint gate
// (`server/utils/agentic/crossBoundary.ts`). A deny may carry a short note
// ("No, search for X instead") that the model reads with the decline. Initiator only (404 for anybody
// else, like the GET). 409 when no longer pending (answered, timed out, which
// counts as deny, or a stale id).

export default defineApiHandler({
  access: allow.user(),
  params: aiSessionParams,
  body: confirmAiSessionBody,
  handler: async ({ user, params, body }) => {
    const { sessionId } = params
    const snapshot = await readSessionChannel(sessionId)
    if (snapshot?.initiatorUserId !== user.id) throw apiError('ai/session-not-found')
    const recorded = await answerSessionConfirmation(sessionId, body.confirmationId, { allow: body.allow, note: body.note })
    if (!recorded) throw apiError('ai/confirmation-not-pending')
    return { ok: true }
  }
})
