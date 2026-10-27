import { readSessionChannel } from '../../../../utils/agentic/sessionChannel'

// GET /api/ai/sessions/:sessionId — the initiator's private view of an
// AI session: their prompt, the live status message, the latest
// `message_to_user` answer and any pending confirmation request.
//
// Initiator only. Everybody else (other participants of the document
// included) gets 404 — the same answer as for an unknown or expired
// session, so a session id reveals nothing. Other participants see the
// coarse "markoto is working" state through Y.js awareness instead.

const SESSION_ID_RE = /^[\w-]{1,64}$/

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const sessionId = getRouterParam(event, 'sessionId') ?? ''
  if (!SESSION_ID_RE.test(sessionId)) {
    throw createError({ statusCode: 400, message: 'Invalid sessionId' })
  }
  const snapshot = await readSessionChannel(sessionId)
  if (snapshot?.initiatorUserId !== session.user.id) {
    throw createError({ statusCode: 404, message: 'AI session not found', data: { code: 'ai/session-not-found' } })
  }
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  return {
    sessionId: snapshot.sessionId,
    docId: snapshot.docId,
    prompt: snapshot.prompt,
    commentThreadId: snapshot.commentThreadId,
    phase: snapshot.status?.phase ?? 'thinking',
    message: snapshot.status?.message ?? null,
    response: snapshot.response,
    confirmation: snapshot.confirmation
  }
})
