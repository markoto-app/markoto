import {
  openTrustedCommentClient,
  findComment,
  readReplyAuthor
} from '../../../../../../utils/commentsServerClient'

// DELETE /api/docs/:docId/comments/:commentId/replies/:replyId
//
// Same authorization shape as the parent comment-delete endpoint:
// only the reply's author or a doc manager can delete it.

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)
  const commentId = getRouterParam(event, 'commentId')
  const replyId = getRouterParam(event, 'replyId')
  if (!commentId || commentId.length > 64) throw createError({ statusCode: 400, message: 'Invalid commentId' })
  if (!replyId || replyId.length > 64) throw createError({ statusCode: 400, message: 'Invalid replyId' })

  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  const authz = await getDocAuthz(userId, docId)
  if (!authz.exists) throw createError({ statusCode: 404, message: 'Document not found' })
  if (!authz.canEdit) throw createError({ statusCode: 403, message: 'Cannot edit this document' })

  const client = await openTrustedCommentClient(docId, `comments-server:delete-reply:${userId}`)
  try {
    const found = findComment(client.ycomments, commentId)
    if (!found) return { ok: true, alreadyGone: true }
    const reply = readReplyAuthor(found.map, replyId)
    if (!reply) return { ok: true, alreadyGone: true }

    const isAuthor = reply.author.authorId !== null && reply.author.authorId === userId
    const isManager = authz.canManage
    if (!isAuthor && !isManager) {
      throw createError({ statusCode: 403, message: 'Only the author can delete this reply' })
    }
    client.ydoc.transact(() => {
      reply.repliesArr.delete(reply.index, 1)
      found.map.set('updatedAt', Date.now())
    }, 'comments-server')
    return { ok: true }
  } finally {
    await client.destroy()
  }
})
