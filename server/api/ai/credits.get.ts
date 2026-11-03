import { resolveBillingContext } from '../../utils/billing'
import { getUserKeyInfo } from '../../utils/litellmKeys'
import { getWorkspaceRole } from '../../utils/workspaceAccess'
import { dollarsToPoints, planToPointsTotal } from '~~/shared/billing/aiPoints'
import { getTiers } from '~~/server/utils/tierConfig'
import { freeAllowanceView } from '../../utils/freeAllowance'

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
 *      pays for the call — equals the caller for self-bill, equals
 *      the workspace sponsor when `(+)` is active).
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

  // Optional `workspaceId` query param so the UI can show the
  // workspace's `(+)` pool while the user is on `/w/:wsId` or in a
  // sponsored doc.
  const query = getQuery(event)
  const requestedWorkspaceId = typeof query.workspaceId === 'string' ? query.workspaceId : null

  // Only honour the workspace billing context if the caller is actually a
  // member. `resolveBillingContext` checks the sponsor's plan + `aiEnabled`
  // but NOT membership, so without this gate any logged-in user who learns a
  // `(+)` workspace id (e.g. from a shared doc URL or a lapsed membership)
  // could read the sponsor's live budget/points. Non-members fall back to
  // their own self-billed context.
  const workspaceId = requestedWorkspaceId
    && (await getWorkspaceRole(userId, requestedWorkspaceId)) !== null
    ? requestedWorkspaceId
    : null

  const billing = await resolveBillingContext(userId, workspaceId)

  // Phase 7: read the live key info from the SAME user whose budget
  // is actually charged. For self-bill that's the caller; for `(+)`
  // workspaces it's the sponsor. The points number then matches what
  // gets debited on the next AI call.
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
    freeAllowance
  }
})
