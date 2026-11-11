import { readSessionChannel, toSessionView } from '../../../../utils/agentic/sessionChannel'
import { ID_RE } from '~~/shared/config/identifiers'

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

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const sessionId = getRouterParam(event, 'sessionId') ?? ''
  if (!ID_RE.test(sessionId)) {
    throw createError({ statusCode: 400, message: 'Invalid sessionId' })
  }
  const snapshot = await readSessionChannel(sessionId)
  if (snapshot?.initiatorUserId !== session.user.id) {
    throw createError({ statusCode: 404, message: 'AI session not found', data: { code: 'ai/session-not-found' } })
  }
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  return toSessionView(snapshot)
})
