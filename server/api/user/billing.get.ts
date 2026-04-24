import { resolveBillingContext } from '../../utils/billing'
import { countOwnedWorkspacesByUser } from '../../repos/workspaces'
import { countKnowledgeByUploader, sumKnowledgeBytesByUploader } from '../../repos/knowledge'
import { TIERS } from '~~/shared/config/tiers'

/**
 * Session-level billing summary for the current user. Drives:
 *   - the topbar credits badge + popover
 *   - pre-disabled "New workspace" / knowledge upload buttons across
 *     the app when the caller's quota is full
 *
 * Workspace-scoped attribution (via `(+)`) is NOT reported here —
 * the AI call itself resolves the workspace context per-request, and
 * the UI surfaces "billed to {ownerName}" in `AIPromptBar` during an
 * active session. This endpoint is always the caller's personal plan.
 *
 * The caps `*Limit` fields are echoed from `shared/config/tiers.ts`
 * so the UI doesn't need its own TIERS import to compare counts —
 * one fetch, everything a cap-aware UI needs.
 */
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id
  const ctx = await resolveBillingContext(userId, null)
  const tier = TIERS[ctx.plan]

  // Counted in parallel — each is a single COUNT/SUM, same latency as
  // a handful of cached lookups. Shipped alongside the limits so the
  // UI just checks `used >= limit` without a second round-trip.
  const [ownedWorkspaces, knowledgeFiles, knowledgeBytes] = await Promise.all([
    countOwnedWorkspacesByUser(userId),
    countKnowledgeByUploader(userId),
    sumKnowledgeBytesByUploader(userId)
  ])

  return {
    plan: ctx.plan,
    interactionsRemaining: ctx.interactionsRemaining,
    interactionsLimit: tier.interactionsPerMonth,
    // Both start and end of the current billing period. UI reads
    // `periodEnd` for the "Resets {date}" line so it matches Stripe
    // invoice dates exactly (don't derive from periodStart + 1 month
    // — that's wrong for different month lengths and for Stripe's
    // anniversary cycles).
    periodStart: ctx.periodStart.toISOString(),
    periodEnd: ctx.periodEnd.toISOString(),

    // Non-interaction caps — `_used` counted from the DB, `_limit`
    // comes from the tier config.
    ownedWorkspaces,
    workspacesOwnedLimit: tier.workspacesOwned,
    knowledgeFilesUsed: knowledgeFiles,
    knowledgeFilesLimit: tier.knowledgeFiles,
    knowledgeBytesUsed: knowledgeBytes,
    knowledgeBytesPerUserLimit: tier.knowledgeBytesPerUser
  }
})
