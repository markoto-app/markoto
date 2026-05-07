import { getAiSession, removeAiSession } from '../../utils/aiSessions'

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  const body = await readBody(event) as { sessionId?: string }
  const sessionId = body.sessionId
  if (!sessionId || typeof sessionId !== 'string') {
    throw createError({ statusCode: 400, message: 'Missing sessionId' })
  }

  const aiSession = await getAiSession(sessionId)
  if (!aiSession) {
    // Already done or never existed — treat as success
    return { success: true, note: 'session not found (may have already finished)' }
  }

  if (aiSession.initiatorUserId !== userId) {
    throw createError({
      statusCode: 403,
      message: 'Only the initiator can cancel their AI session',
      data: { code: 'ai/abort-not-initiator', messageKey: 'ai.errors.abortNotInitiator' }
    })
  }

  if (aiSession.abortController) {
    aiSession.abortController.abort()
    return { success: true }
  }

  // Row exists in the DB but no local AbortController — this process isn't
  // the one running the agentic loop (e.g. after a restart the DB row
  // survived, or a future multi-worker setup). Best we can do from here is
  // drop the registry row so the per-user cap unblocks; the stuck loop (if
  // any) will exit on its own deadline. Awareness cleanup happens when that
  // loop's finally block runs.
  await removeAiSession(sessionId)
  return { success: true, note: 'session was orphaned (no abort controller in this process); registry cleared' }
})
