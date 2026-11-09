import { isBillingEnabled } from '../../utils/billingMode'
import { resolveBillingContext } from '../../utils/billing'
import { countOwnedWorkspacesByUser } from '../../repos/workspaces'
import { countKnowledgeByUploader, sumKnowledgeBytesByUploader } from '../../repos/knowledge'
import { sumImageBytesByUploader } from '../../repos/uploads'
import { getTiers } from '~~/server/utils/tierConfig'

/**
 * Session-level billing summary for the current user. Drives:
 *   - pre-disabled "New workspace" / knowledge upload buttons across
 *     the app when the caller's quota is full
 *   - plan badge in the workspace header
 *
 * Phase 6: AI budget went to LiteLLM virtual keys; the AI Points UI
 * (badge + low-points warning) is wired through `/api/ai/credits`,
 * NOT this endpoint. Here we only return the structural caps + plan.
 */
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id
  const ctx = await resolveBillingContext(userId, null)
  const tier = getTiers()[ctx.plan]

  const [ownedWorkspaces, knowledgeFiles, knowledgeBytes, imageBytes] = await Promise.all([
    countOwnedWorkspacesByUser(userId),
    // Personal storage only: files and images in Team / Business
    // workspaces count against those workspaces' pools (WP3).
    countKnowledgeByUploader(userId, { excludePooled: isBillingEnabled() }),
    sumKnowledgeBytesByUploader(userId, { excludePooled: isBillingEnabled() }),
    sumImageBytesByUploader(userId, { excludePooled: isBillingEnabled() })
  ])

  return {
    plan: ctx.plan,
    periodStart: ctx.periodStart.toISOString(),
    periodEnd: ctx.periodEnd.toISOString(),

    ownedWorkspaces,
    workspacesOwnedLimit: tier.workspacesOwned,
    knowledgeFilesUsed: knowledgeFiles,
    knowledgeFilesLimit: tier.knowledgeFiles,
    knowledgeBytesUsed: knowledgeBytes,
    knowledgeBytesPerUserLimit: tier.knowledgeBytesPerUser,
    // Document images (uploads + AI images + duplicate copies), pending
    // uploads included — the same sum the upload quota enforces.
    imageBytesUsed: imageBytes,
    imageBytesPerUserLimit: tier.imageBytesPerUser
  }
})
