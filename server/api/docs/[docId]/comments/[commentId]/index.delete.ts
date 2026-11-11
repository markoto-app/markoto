import {
  openTrustedCommentClient,
  findComment,
  readCommentAuthor
} from '../../../../../utils/documents/commentsServerClient'
import { commentParams } from '~~/shared/api/ai'

// DELETE /api/docs/:docId/comments/:commentId
//
// Authorization: only the comment's author can delete their own
// comment. Doc owner / workspace admin gets a manage-grade override
// (same shape as `canManageDoc`). Anyone else: 403.
//
// Server-side because a client mutating the Y.Array directly could be
// spoofed by any peer with edit access; here the action is bound to the JWT
// user and the author is looked up from the live Y.Doc.
//
// The server connects briefly to Hocuspocus, mutates the `comments` Y.Array
// and disconnects; editors see the deletion over the live channel.

export default defineApiHandler({
  access: allow.doc('edit'),
  params: commentParams,
  handler: async ({ user, docId, authz, params }) => {
    const userId = user.id
    const { commentId } = params

    const client = await openTrustedCommentClient(docId, `comments-server:delete:${userId}`)
    try {
      const found = findComment(client.ycomments, commentId)
      if (!found) {
      // Already deleted: idempotent OK.
        return { ok: true, alreadyGone: true }
      }
      const author = readCommentAuthor(found.map)
      const isAuthor = author.authorId !== null && author.authorId === userId
      const isManager = authz.canManage
      if (!isAuthor && !isManager) {
        throw apiError('ai/comment-not-author')
      }
      client.ydoc.transact(() => {
        client.ycomments.delete(found.index, 1)
      }, 'comments-server')
      return { ok: true }
    } finally {
      await client.destroy()
    }
  }
})
