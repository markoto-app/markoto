import { getKnowledge } from '../../../../repos/knowledge'
import { deleteKnowledgeArtifact } from '../../../../utils/knowledge/knowledgeAccess'
import { workspaceKnowledgeParams } from '~~/shared/api/workspaces'

/**
 * Delete a knowledge file. Chunks cascade with the row via FK; the S3
 * object is best-effort cleaned up. Authorization: admin, or editor
 * who uploaded it; viewers never.
 */

export default defineApiHandler({
  access: allow.workspace('editor', { deny: 'knowledge/editor-required' }),
  params: workspaceKnowledgeParams,
  handler: async ({ user, wsId, role, params, workspaceAccess }) => {
    const knowledgeId = params.knowledgeId

    // Keyed on this workspace: a row of another workspace is not found,
    // resolved BEFORE the uploader check so callers can't probe for it.
    const row = await getKnowledge(workspaceAccess, knowledgeId)
    if (row?.workspaceId !== wsId) {
      throw apiError('knowledge/not-found')
    }
    // Editors may only delete their own uploads (a missing uploader can only
    // be cleaned up by an admin).
    if (role !== 'admin' && (row.uploaderId === null || row.uploaderId !== user.id)) {
      throw apiError('knowledge/not-uploader')
    }

    await deleteKnowledgeArtifact(workspaceAccess, knowledgeId)

    return { success: true }
  }
})
