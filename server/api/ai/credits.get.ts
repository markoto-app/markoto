import { resolveBillingContext } from '../../utils/billing/billing'
import { getUserKeyInfo } from '../../utils/litellm/userKeys'
import { getWorkspaceRole } from '../../utils/workspaces/workspaceAccess'
import { dollarsToPoints, planToPointsTotal } from '~~/shared/billing/aiPoints'
import { getTiers } from '~~/server/utils/billing/tierConfig'
import { freeAllowanceView } from '../../utils/billing/freeAllowance'
import { readMemberKeySpend, readWorkspaceTeam } from '../../utils/litellm/workspaceTeams'
import { getPooledWorkspace, memberLimitUsd, workspacePoolCaps } from '../../utils/billing/workspaceBilling'
import { and, eq } from 'drizzle-orm'
import { workspaceMembers } from '../../db/schema'
import { useDatabase } from '../../utils/platform/database'

/**
 * GET /api/ai/credits — AI Points UI data source.
 *
 * Returns the user's current LiteLLM spend translated to AI Points
 * (1000 pts = $1.00 USD), plus the plan + period-end so the UI can
 * render "1247 / 5000 AI Points • resets {date}".
 *
 * Resolution order:
 *   1. `resolveBillingContext` to determine the effective plan +
 *      `billingUserId` (the user whose virtual-key budget actually
 *      pays for the call — today always the caller; Team workspaces
 *      bill a pooled workspace budget from WP3).
 *   2. `getUserKeyInfo(billingUserId, plan)` for live spend +
 *      max_budget from the LiteLLM proxy.
 *   3. Convert: `pointsRemaining = (max_budget - spend) × 1000`.
 *   4. `freeAllowance`: the shared monthly free-tier pool's state
 *      (`{pooled, exhausted, resetsAt}`), null when not pooled.
 *
 * Auth-gated. Anonymous users have no AI budget — the endpoint is
 * not whitelisted in middleware/auth.ts.
 */

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  // Optional `workspaceId` query param so the UI can show a Team
  // workspace's pooled budget while the user is on `/w/:wsId` or in one
  // of its docs (WP3).
  const query = getQuery(event)
  const requestedWorkspaceId = typeof query.workspaceId === 'string' ? query.workspaceId : null

  // Only honour the workspace billing context if the caller is actually a
  // member: without this gate any logged-in user who learns a workspace id
  // (e.g. from a shared doc URL or a lapsed membership) could read that
  // workspace's live budget. Non-members fall back to their own context.
  const workspaceId = requestedWorkspaceId
    && (await getWorkspaceRole(userId, requestedWorkspaceId)) !== null
    ? requestedWorkspaceId
    : null

  const billing = await resolveBillingContext(userId, workspaceId)

  // Team / Business workspace (WP3): the member's key in the workspace
  // team. Remaining = the smaller of what's left of the member's limit
  // and of the team pool; `workspace` carries both for the usage panel.
  if (billing.attribution === 'workspace' && billing.workspaceId) {
    const pool = await getPooledWorkspace(billing.workspaceId)
    const caps = pool ? workspacePoolCaps(pool.plan, pool.seats) : null
    const [member, team, row] = await Promise.all([
      readMemberKeySpend(billing.virtualKey),
      readWorkspaceTeam(billing.workspaceId).catch(() => null),
      useDatabase()
        .select({ aiLimitUsd: workspaceMembers.aiLimitUsd, aiUnlimited: workspaceMembers.aiUnlimited })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, billing.workspaceId), eq(workspaceMembers.userId, userId)))
        .limit(1)
        .then(rows => rows[0] ?? null)
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
        workspaceId: billing.workspaceId,
        teamBudgetUsd: teamBudget,
        teamSpendUsd: teamSpend,
        memberLimitUsd: memberLimit,
        memberSpendUsd: memberSpend,
        exhausted: remaining <= 0,
        teamExhausted: teamLeft <= 0
      }
    }
  }

  // Phase 7: read the live key info from the SAME budget that is
  // actually charged, so the points number matches what gets debited on
  // the next AI call.
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
})
