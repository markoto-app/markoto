import { readSessionChannel, toSessionView } from '../../../../utils/agentic/sessionChannel'
import { aiSessionParams } from '~~/shared/api/ai'

// GET /api/ai/sessions/:sessionId: the initiator's private view of an AI
// session (prompt, live status, latest `message_to_user`, pending
// confirmation).
//
// Initiator only. Everybody else gets the same 404 as for an unknown or expired
// session, so a session id reveals nothing; other participants see the coarse
// "markoto is working" state through Y.js awareness.
//
// The prompt bar follows the push stream (`./stream.get.ts`); this is the
// fallback when the stream breaks and the final read after the session ended.

export default defineApiHandler({
  access: allow.user(),
  params: aiSessionParams,
  handler: async ({ event, user, params }) => {
    const snapshot = await readSessionChannel(params.sessionId)
    if (snapshot?.initiatorUserId !== user.id) throw apiError('ai/session-not-found')
    setResponseHeader(event, 'Cache-Control', 'private, no-store')
    return toSessionView(snapshot)
  }
})
