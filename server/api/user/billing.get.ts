import { creditBalanceView } from '../../utils/billing/aiCreditBudget'
import { pooledPlansFor } from '../../utils/billing/workspaceBilling'
import { isBillingEnabled } from '../../utils/billing/billingMode'
import { resolveBillingContext } from '../../utils/billing/billing'
import { countOwnedWorkspacesByUser, listWorkspacesForUser } from '../../repos/workspaces'
import { countKnowledgeByUploader, sumKnowledgeBytesByUploader } from '../../repos/knowledge'
import { sumImageBytesByUploader } from '../../repos/uploads'
import { getTiers } from '~~/server/utils/billing/tierConfig'

/**
 * Session-level billing summary for the current user. Drives:
 *   - pre-disabled "New workspace" / knowledge upload buttons across
 *     the app when the caller's quota is full
 *   - plan badge in the workspace header
 *
 * AI budget is not here: the AI Points UI (badge + low-points warning)
 * reads `/api/ai/credits`. This endpoint returns only structural caps + plan.
 */
export default defineApiHandler({
  access: allow.user(),
  handler: async ({ user }) => {
    const userId = user.id
    const ctx = await resolveBillingContext(userId, null)
    const tier = getTiers()[ctx.plan]

    const [ownedWorkspaces, knowledgeFiles, knowledgeBytes, imageBytes] = await Promise.all([
      countOwnedWorkspacesByUser(userId),
      // Personal storage only: files and images in Team / Business
      // workspaces count against those workspaces' pools.
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
      imageBytesPerUserLimit: tier.imageBytesPerUser,
      // AI credit top-ups: balance + purchases. Null with billing off.
      credits: isBillingEnabled() ? await creditBalanceView({ type: 'user', id: String(userId) }) : null,
      // Workspaces whose Team / Business plan covers the user inside them.
      coveringWorkspaces: await coveringWorkspaces(userId)
    }
  }
})

async function coveringWorkspaces(userId: number): Promise<Array<{ workspaceId: string, name: string, plan: 'team' | 'business' }>> {
  const rows = await listWorkspacesForUser(userId)
  const plans = await pooledPlansFor(rows.map(r => r.workspaceId))
  return rows.flatMap((r) => {
    const plan = plans.get(r.workspaceId)
    return plan ? [{ workspaceId: r.workspaceId, name: r.name, plan }] : []
  })
}
