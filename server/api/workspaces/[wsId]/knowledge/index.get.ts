import { listKnowledge, countWorkspaceKnowledge, sumWorkspaceKnowledgeBytes } from '../../../../repos/knowledge'

/**
 * List knowledge files in a workspace. Any member role can call this.
 *
 * The response includes aggregate workspace usage so the UI can render
 * a "X MB of Y MB used" indicator in a single fetch. We exclude
 * `markdownCache` (potentially large) from the per-row payload — it's
 * fetched on demand by the AI's `get_knowledge_file` tool.
 */

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  const userId = session.user.id

  await requireKnowledgeViewAccess(event, wsId, userId)

  const [rows, count, totalBytes] = await Promise.all([
    listKnowledge(wsId),
    countWorkspaceKnowledge(wsId),
    sumWorkspaceKnowledgeBytes(wsId)
  ])

  const config = useRuntimeConfig()

  return {
    items: rows.map(r => ({
      knowledgeId: r.knowledgeId,
      filename: r.filename,
      sourceExt: r.sourceExt,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      status: r.status,
      errorMessage: r.errorMessage,
      chunkCount: r.chunkCount,
      tokenCount: r.tokenCount,
      uploaderId: r.uploaderId,
      createdAt: r.createdAt,
      processedAt: r.processedAt
    })),
    usage: {
      count,
      totalBytes,
      maxFiles: config.knowledge.maxFilesPerWorkspace,
      maxBytes: config.knowledge.maxTotalBytesPerWorkspace,
      maxFileBytes: config.knowledge.maxFileBytes
    }
  }
})
