import { resolveBillingContext } from '../../utils/billing/billing'
import { getUserKeyInfo } from '../../utils/litellm/userKeys'
import { proveWorkspaceAccess } from '../../utils/access/workspaceAccess'
import { dollarsToPoints, planToPointsTotal } from '~~/shared/billing/aiPoints'
import { getTiers } from '~~/server/utils/billing/tierConfig'
import { freeAllowanceView } from '../../utils/billing/freeAllowance'
import { readMemberKeySpend, readWorkspaceTeam } from '../../utils/litellm/workspaceTeams'
import { getPooledWorkspace, memberLimitUsd, workspacePoolCaps } from '../../utils/billing/workspaceBilling'
import { getOwnAiLimit } from '../../repos/workspaceBilling'
import { aiCreditsQuery } from '~~/shared/api/ai'
import type { UserScope, WorkspaceAccess } from '../../repos/proofs'

/**
 * GET /api/ai/credits: AI Points UI data (1000 pts = $1.00 USD).
 *
 * Returns the user's LiteLLM spend as AI Points plus plan and period end.
 * `resolveBillingContext` picks the effective plan and `billingUserId` (whose
 * virtual-key budget pays); `getUserKeyInfo` gives live spend + max_budget;
 * `pointsRemaining = (max_budget - spend) * 1000`. `freeAllowance` is the
 * shared monthly free-tier pool state (`{pooled, exhausted, resetsAt}`), null
 * when not pooled.
 *
 * Auth-gated (not whitelisted in middleware/auth.ts): anonymous users have no
 * AI budget.
 */

export default defineApiHandler({
  access: allow.user(),
  query: aiCreditsQuery,
  handler: async ({ user, self, query }) => {
    const userId = user.id

    // Optional `workspaceId` so the UI can show a Team workspace's pooled budget.
    const requestedWorkspaceId = query.workspaceId ?? null

    // Honour the workspace context only for members: otherwise any logged-in
    // user who learns a workspace id could read its live budget. Non-members
    // fall back to their own context.
    const membership = requestedWorkspaceId ? await proveWorkspaceAccess(userId, requestedWorkspaceId, 'member') : null
    const workspaceId = membership?.workspaceId ?? null

    const billing = await resolveBillingContext(userId, workspaceId)

    // Team / Business workspace: the member's key in the workspace team.
    // Remaining = the smaller of the member's limit and the team pool;
    // `workspace` carries both for the usage panel.
    if (billing.attribution === 'workspace' && billing.workspaceId) {
      return workspaceCredits(billing, billing.workspaceId, membership, self)
    }

    // Read live key info from the same budget that is actually charged.
    const info = await getUserKeyInfo(billing.billingUserId, billing.plan)

    const remainingDollars = Math.max(0, info.maxBudget - info.spend)
    const pointsRemaining = dollarsToPoints(remainingDollars)
    const pointsTotal = planToPointsTotal(billing.plan, getTiers())
    // Free tier on an instance with a global monthly ceiling: the key also
    // draws on the shared pool (`litellm/freeTierTeam.ts`). When the pool is
    // used up the user's own points don't help — the UI says so and links
    // the own-key settings instead. Null when the plan isn't pooled.
    const freeAllowance = await freeAllowanceView(billing.plan)

    return {
      pointsRemaining,
      pointsTotal,
      plan: billing.plan,
      periodEnd: billing.periodEnd.toISOString(),
      attribution: billing.attribution,
      freeAllowance,
      workspace: null
    }
  }
})

/**
 * Team / Business workspace: the member's key in the workspace team.
 * Remaining = the smaller of the member's limit and the team pool;
 * `workspace` carries both for the usage panel.
 */
async function workspaceCredits(
  billing: Awaited<ReturnType<typeof resolveBillingContext>>,
  workspaceId: string,
  membership: WorkspaceAccess<'member'> | null,
  self: UserScope
) {
  const pool = await getPooledWorkspace(workspaceId)
  const caps = pool ? workspacePoolCaps(pool.plan, pool.seats) : null
  const [member, team, row] = await Promise.all([
    readMemberKeySpend(billing.virtualKey),
    readWorkspaceTeam(workspaceId).catch(() => null),
    // The pooled workspace is the requested one (billing resolves it from
    // the membership proved above).
    membership ? getOwnAiLimit(membership, self) : null
  ])
  const teamBudget = typeof team?.max_budget === 'number' ? team.max_budget : caps?.aiBudgetUsd ?? 0
  const teamSpend = typeof team?.spend === 'number' ? team.spend : 0
  const memberSpend = member?.spend ?? 0
  // The stored limit is the source of truth (the key carries the same
  // value; `syncMemberKeyLimit` keeps them in step).
  const memberLimit = caps && row ? memberLimitUsd(row, caps) : member?.maxBudget ?? null
  const teamLeft = Math.max(0, teamBudget - teamSpend)
  const memberLeft = memberLimit === null ? teamLeft : Math.max(0, memberLimit - memberSpend)
  const remaining = Math.min(teamLeft, memberLeft)
  return {
    pointsRemaining: dollarsToPoints(remaining),
    pointsTotal: dollarsToPoints(memberLimit ?? teamBudget),
    plan: billing.plan,
    periodEnd: billing.periodEnd.toISOString(),
    attribution: billing.attribution,
    freeAllowance: null,
    workspace: {
      workspaceId: workspaceId,
      teamBudgetUsd: teamBudget,
      teamSpendUsd: teamSpend,
      memberLimitUsd: memberLimit,
      memberSpendUsd: memberSpend,
      exhausted: remaining <= 0,
      teamExhausted: teamLeft <= 0
    }
  }
}
