import { getAiSession, removeAiSession } from '../../utils/ai/aiSessions'

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  const body = await readBody(event)
  const sessionId = body.sessionId
  if (!sessionId || typeof sessionId !== 'string') {
    throw createError({ statusCode: 400, message: 'Missing sessionId' })
  }

  const aiSession = await getAiSession(sessionId)
  if (!aiSession) {
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

  // Row exists but no local AbortController: this process isn't running the
  // loop. Drop the registry row so the per-user cap unblocks; a stuck loop
  // exits on its own deadline and cleans up awareness in its finally block.
  await removeAiSession(sessionId)
  return { success: true, note: 'session was orphaned (no abort controller in this process); registry cleared' }
})
