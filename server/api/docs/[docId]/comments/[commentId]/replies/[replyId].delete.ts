import {
  openTrustedCommentClient,
  findComment,
  readReplyAuthor
} from '../../../../../../utils/documents/commentsServerClient'
import { replyParams } from '~~/shared/api/ai'

// DELETE /api/docs/:docId/comments/:commentId/replies/:replyId
//
// Same authorization shape as the parent comment-delete endpoint:
// only the reply's author or a doc manager can delete it.

export default defineApiHandler({
  access: allow.doc('edit'),
  params: replyParams,
  handler: async ({ user, docId, authz, params }) => {
    const userId = user.id
    const { commentId, replyId } = params

    const client = await openTrustedCommentClient(docId, `comments-server:delete-reply:${userId}`)
    try {
      const found = findComment(client.ycomments, commentId)
      if (!found) return { ok: true, alreadyGone: true }
      const reply = readReplyAuthor(found.map, replyId)
      if (!reply) return { ok: true, alreadyGone: true }

      const isAuthor = reply.author.authorId !== null && reply.author.authorId === userId
      const isManager = authz.canManage
      if (!isAuthor && !isManager) {
        throw apiError('ai/comment-not-author')
      }
      client.ydoc.transact(() => {
        reply.repliesArr.delete(reply.index, 1)
        found.map.set('updatedAt', Date.now())
      }, 'comments-server')
      return { ok: true }
    } finally {
      await client.destroy()
    }
  }
})
