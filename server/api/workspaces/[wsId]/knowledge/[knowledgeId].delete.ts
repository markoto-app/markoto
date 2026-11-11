import { getKnowledge } from '../../../../repos/knowledge'
import { deleteKnowledgeArtifact, requireKnowledgeDeleteAccess } from '../../../../utils/knowledge/knowledgeAccess'

/**
 * Delete a knowledge file. Chunks cascade with the row via FK; the S3
 * object is best-effort cleaned up. Authorization: admin, or editor
 * who uploaded it (see requireKnowledgeDeleteAccess).
 */

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  const userId = session.user.id

  const knowledgeId = getRouterParam(event, 'knowledgeId')
  if (!knowledgeId) {
    throw createError({ statusCode: 400, message: 'Missing knowledgeId' })
  }

  const row = await getKnowledge(knowledgeId)
  // Resolve workspace scope BEFORE running the authz check so callers
  // can't probe for knowledge in another workspace via this endpoint.
  if (row?.workspaceId !== wsId) {
    throw createError({ statusCode: 404, message: 'Knowledge file not found' })
  }

  await requireKnowledgeDeleteAccess(event, wsId, userId, row.uploaderId)
  await deleteKnowledgeArtifact(knowledgeId)

  return { success: true }
})
