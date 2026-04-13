import { getAiSession } from '../../utils/aiSessions'

export default defineEventHandler(async (event) => {
  const session = await requireUserSession(event)
  const userId = session.user.id as number

  const body = await readBody(event) as { sessionId?: string }
  const sessionId = body.sessionId
  if (!sessionId || typeof sessionId !== 'string') {
    throw createError({ statusCode: 400, message: 'Missing sessionId' })
  }

  const aiSession = getAiSession(sessionId)
  if (!aiSession) {
    // Already done or never existed — treat as success
    return { success: true, note: 'session not found (may have already finished)' }
  }

  if (aiSession.initiatorUserId !== userId) {
    throw createError({
      statusCode: 403,
      message: 'Only the initiator can cancel their Claude session'
    })
  }

  aiSession.abortController.abort()
  return { success: true }
})
