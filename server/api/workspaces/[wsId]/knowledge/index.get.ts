import { listKnowledge, countWorkspaceKnowledge, sumWorkspaceKnowledgeBytes } from '../../../../repos/knowledge'
import { resolveCaps } from '../../../../utils/knowledge/knowledgeQuota'

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

  const [rows, count, totalBytes, caps] = await Promise.all([
    listKnowledge(wsId),
    countWorkspaceKnowledge(wsId),
    sumWorkspaceKnowledgeBytes(wsId),
    resolveCaps({ workspaceId: wsId, uploaderId: userId })
  ])

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
      // Workspace-scoped caps: the Team / Business pool (seats × per
      // seat) when the workspace has a subscription, else the
      // workspace creator's tier.
      maxFiles: caps.maxFilesPerWorkspace,
      maxBytes: caps.maxTotalBytesPerWorkspace,
      maxFileBytes: caps.maxFileBytes,
      // Diagnostic: which plan's caps are being applied. Lets the UI
      // show "Billed to {owner} at Max tier" without a separate call.
      workspacePlan: caps.workspacePlan,
      uploaderPlan: caps.uploaderPlan,
      pooled: caps.pooled
    }
  }
})
