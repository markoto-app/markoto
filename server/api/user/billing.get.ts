import { creditBalanceView } from '../../utils/billing/aiCreditBudget'
import { pooledPlansFor } from '../../utils/billing/workspaceBilling'
import { isBillingEnabled } from '../../utils/billing/billingMode'
import { resolveBillingContext } from '../../utils/billing/billing'
import { countOwnedWorkspacesByUser, listWorkspacesForUser } from '../../repos/workspaces'
import { countKnowledgeByUploader, sumKnowledgeBytesByUploader } from '../../repos/knowledge'
import { sumImageBytesByUploader } from '../../repos/uploads'
import { getTiers } from '~~/server/utils/billing/tierConfig'
import { getOwnSubscriptionFacts } from '../../repos/userBilling'
import { billingIntervalOfPeriod } from '~~/shared/config/pricing'
import { isPaymentOverdueStatus } from '~~/shared/contracts/stripe'
import type { UserScope } from '../../repos/proofs'

/**
 * Session-level billing summary for the current user. Drives:
 *   - pre-disabled "New workspace" / knowledge upload buttons across
 *     the app when the caller's quota is full
 *   - plan badge in the workspace header
 *
 * AI budget is not here: the AI Points UI (badge + low-points warning)
 * reads `/api/ai/credits`. This endpoint returns structural caps, the plan and
 * the personal subscription's billing period / end date.
 */
export default defineApiHandler({
  access: allow.user(),
  handler: async ({ user, self }) => {
    const userId = user.id
    const ctx = await resolveBillingContext(userId, null)
    const tier = getTiers()[ctx.plan]

    const [ownedWorkspaces, knowledgeFiles, knowledgeBytes, imageBytes] = await Promise.all([
      countOwnedWorkspacesByUser(self),
      // Personal storage only: files and images in Team / Business
      // workspaces count against those workspaces' pools.
      countKnowledgeByUploader(self, { excludePooled: isBillingEnabled() }),
      sumKnowledgeBytesByUploader(self, { excludePooled: isBillingEnabled() }),
      sumImageBytesByUploader(self, { excludePooled: isBillingEnabled() })
    ])

    // The personal subscription behind a paid plan: its billing period and,
    // once cancelled, when it ends.
    const subscription = ctx.plan === 'pro' ? await getOwnSubscriptionFacts(self) : null

    return {
      plan: ctx.plan,
      periodStart: ctx.periodStart.toISOString(),
      periodEnd: ctx.periodEnd.toISOString(),
      // 'month' | 'year' on a paid plan, null on Free. Subscriptions stored
      // before the interval was recorded are judged by their period length.
      interval: subscription ? subscription.billingInterval ?? billingIntervalOfPeriod(ctx.periodStart, ctx.periodEnd) : null,
      // Set when the subscription was cancelled and ends then instead of renewing.
      cancelAt: subscription?.planCancelAt?.toISOString() ?? null,
      // The last renewal was not paid and Stripe is retrying: the plan still
      // runs, the page asks for a working payment method.
      paymentOverdue: isPaymentOverdueStatus(subscription?.subscriptionStatus),

      ownedWorkspaces,
      workspacesOwnedLimit: tier.workspacesOwned,
      knowledgeFilesUsed: knowledgeFiles,
      knowledgeFilesLimit: tier.knowledgeFiles,
      knowledgeBytesUsed: knowledgeBytes,
      knowledgeBytesPerUserLimit: tier.knowledgeBytesPerUser,
      // Document images (uploads + AI images + duplicate copies), pending
      // uploads included: the same sum the upload quota enforces.
      imageBytesUsed: imageBytes,
      imageBytesPerUserLimit: tier.imageBytesPerUser,
      // AI credit top-ups: balance + purchases. Null with billing off.
      credits: isBillingEnabled() ? await creditBalanceView({ type: 'user', id: String(userId) }) : null,
      // Workspaces whose Team / Business plan covers the user inside them.
      coveringWorkspaces: await coveringWorkspaces(self)
    }
  }
})

async function coveringWorkspaces(self: UserScope): Promise<Array<{ workspaceId: string, name: string, plan: 'team' | 'business' }>> {
  const rows = await listWorkspacesForUser(self)
  const plans = await pooledPlansFor(rows.map(r => r.workspaceId))
  return rows.flatMap((r) => {
    const plan = plans.get(r.workspaceId)
    return plan ? [{ workspaceId: r.workspaceId, name: r.name, plan }] : []
  })
}
