import {
  openTrustedCommentClient,
  findComment,
  readCommentAuthor
} from '../../../../../utils/documents/commentsServerClient'

// DELETE /api/docs/:docId/comments/:commentId
//
// Authorization: only the comment's author can delete their own
// comment. Doc owner / workspace admin gets a manage-grade override
// (same shape as `canManageDoc`). Anyone else: 403.
//
// Why server-side: the client used to delete by mutating the Y.Array
// directly, which any peer with edit access could spoof. Routing
// delete through the server lets us bind the action to the JWT user,
// look up the actual author from the live Y.Doc, and refuse if they
// don't match.
//
// The trusted client connects briefly to Hocuspocus, mutates the
// `comments` Y.Array, and disconnects. Editors of the doc see the
// deletion arrive over the live channel — no manual refresh.

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)
  const commentId = getRouterParam(event, 'commentId')
  if (!commentId || commentId.length === 0 || commentId.length > 64) {
    throw createError({ statusCode: 400, message: 'Invalid commentId' })
  }
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  const authz = await getDocAuthz(userId, docId)
  if (!authz.exists) throw createError({ statusCode: 404, message: 'Document not found' })
  if (!authz.canEdit) throw createError({ statusCode: 403, message: 'Cannot edit this document' })

  const client = await openTrustedCommentClient(docId, `comments-server:delete:${userId}`)
  try {
    const found = findComment(client.ycomments, commentId)
    if (!found) {
      // Already deleted by another action — idempotent OK.
      return { ok: true, alreadyGone: true }
    }
    const author = readCommentAuthor(found.map)
    const isAuthor = author.authorId !== null && author.authorId === userId
    const isManager = authz.canManage
    if (!isAuthor && !isManager) {
      throw createError({ statusCode: 403, message: 'Only the author can delete this comment' })
    }
    client.ydoc.transact(() => {
      client.ycomments.delete(found.index, 1)
    }, 'comments-server')
    return { ok: true }
  } finally {
    await client.destroy()
  }
})
