import { resolveBillingContext } from '../../utils/billing/billing'
import { getUserKeyInfo } from '../../utils/litellm/userKeys'
import { dollarsToPoints, planToBudgetUsd, splitPlanAndCreditPoints } from '~~/shared/billing/aiPoints'
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
 * `pointsRemaining = (max_budget - spend) * 1000`: everything still usable,
 * the plan's monthly budget AND bought AI credits (the key's budget holds
 * both). `pointsTotal` is the plan's monthly allotment alone, so the two are
 * told apart explicitly: `planPointsRemaining` (never above `pointsTotal`,
 * what a meter shows) and `creditPoints` (the rest, bought credits; the plan
 * budget is spent first). `resetsAt` is when LiteLLM refills the budget,
 * its own 30-day window, not the subscription's renewal (a yearly plan
 * renews once a year). `freeAllowance` is the
 * shared monthly free-tier pool state (`{pooled, exhausted, resetsAt}`), null
 * when not pooled.
 *
 * Auth-gated (not whitelisted in middleware/auth.ts): anonymous users have no
 * AI budget.
 */

export default defineApiHandler({
  access: allow.user(),
  query: aiCreditsQuery,
  handler: async ({ user, self, prove, query }) => {
    const userId = user.id

    // Optional `workspaceId` so the UI can show a Team workspace's pooled budget.
    const requestedWorkspaceId = query.workspaceId ?? null

    // Honour the workspace context only for members: otherwise any logged-in
    // user who learns a workspace id could read its live budget. Non-members
    // fall back to their own context.
    const membership = requestedWorkspaceId ? await prove.workspace(requestedWorkspaceId, 'member') : null
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

    const points = splitPlanAndCreditPoints({
      maxBudgetUsd: info.maxBudget,
      spendUsd: info.spend,
      planBudgetUsd: planToBudgetUsd(billing.plan, getTiers())
    })
    // Free tier on an instance with a global monthly ceiling: the key also
    // draws on the shared pool (`litellm/freeTierTeam.ts`). When the pool is
    // used up the user's own points don't help, the UI says so and links
    // the own-key settings instead. Null when the plan isn't pooled.
    const freeAllowance = await freeAllowanceView(billing.plan)

    return {
      ...points,
      plan: billing.plan,
      periodEnd: billing.periodEnd.toISOString(),
      resetsAt: info.budgetResetAt,
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
    // A workspace's bought credits are part of the team budget above (the
    // billing tab lists them), so the whole remainder counts as budget here.
    planPointsRemaining: dollarsToPoints(remaining),
    creditPoints: 0,
    plan: billing.plan,
    periodEnd: billing.periodEnd.toISOString(),
    resetsAt: team?.budget_reset_at ?? null,
    attribution: billing.attribution,
    freeAllowance: null,
    workspace: {
      workspaceId: workspaceId,
      // Admins can add seats or buy AI Points; members can only ask them.
      canManage: membership?.allows('admin') ?? false,
      teamBudgetUsd: teamBudget,
      teamSpendUsd: teamSpend,
      memberLimitUsd: memberLimit,
      memberSpendUsd: memberSpend,
      exhausted: remaining <= 0,
      teamExhausted: teamLeft <= 0
    }
  }
}
