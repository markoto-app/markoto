import { getAiSession, removeAiSession } from '../../utils/ai/aiSessions'
import { abortAiSessionBody } from '~~/shared/api/ai'

// POST /api/ai/abort { sessionId }: cancels the caller's own AI session.
export default defineApiHandler({
  access: allow.user(),
  body: abortAiSessionBody,
  handler: async ({ user, body }) => {
    const userId = user.id
    const sessionId = body.sessionId

    const aiSession = await getAiSession(sessionId)
    if (!aiSession) {
      return { success: true, note: 'session not found (may have already finished)' }
    }

    if (aiSession.initiatorUserId !== userId) {
      throw apiError('ai/abort-not-initiator')
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
  }
})
