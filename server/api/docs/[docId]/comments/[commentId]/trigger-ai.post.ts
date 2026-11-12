import { commentParams, triggerCommentAiBody } from '~~/shared/api/ai'
import { startCommentTrigger } from '../../../../../utils/agentic/sessions/commentTrigger'

// POST /api/docs/:docId/comments/:commentId/trigger-ai
//
// Body: { replyId?: string }
//
// Spawns an AI agentic loop seeded with the contents of one comment
// thread (`utils/agentic/sessions/commentTrigger.ts`). Used by the client
// when a user submits a comment or reply containing `@ai`. No app-side
// rate limit: the per-user virtual key's rpm_limit is the single
// enforcement point.
//
// Auth: requires login + doc-edit access (same as /api/ai/prompt;
// viewers can write comments but can't summon AI). The triggering
// message must be the CALLER's own and must mention the AI — nobody can
// start a session (on their own budget) seeded with someone else's
// message. Per-user-per-doc session cap still applies.

export default defineApiHandler({
  access: allow.doc('write-content'),
  params: commentParams,
  body: triggerCommentAiBody,
  handler: async ({ event, user, docAccess, self, params, body }) => {
    const replyId = body?.replyId ?? null
    const { sessionId } = await startCommentTrigger(event, {
      docAccess,
      self,
      commentId: params.commentId,
      replyId,
      user: { id: user.id, name: user.name }
    })
    return { sessionId, commentId: params.commentId, replyId }
  }
})
