import type { ApiResponse } from '~/utils/api/client'
import { useAiCreditsQuery, useInvalidateAiCredits } from '~/queries/ai'

export type AiCredits = ApiResponse<'/api/ai/credits', 'get'>

/**
 * AI Points for one budget: one cached query per budget
 * (app/queries/ai.ts), shared by the AIPromptBar badge, the topbar meter
 * and the AI settings page.
 *
 * The `workspaceId` argument reads the budget that pays inside that
 * workspace: a Team / Business workspace's member limit + team pool, else
 * the user's own. Each budget is its own cache entry; the topbar meter and
 * the prompt bar of a document both read the budget of that document's
 * workspace, and share the entry.
 *
 * `refresh()` re-reads this budget. Call it after AI actions
 * that consumed budget (a prompt session ended, a voice prompt). A plan
 * change goes through `useInvalidatePlan()` (app/queries/billing.ts).
 */
export function useAiCredits(workspaceId?: MaybeRefOrGetter<string | null | undefined>) {
  const { loggedIn } = useUserSession()
  const budget = () => toValue(workspaceId) ?? null
  const query = useAiCreditsQuery(budget)
  const refresh = useInvalidateAiCredits(budget)
  // A failed refetch keeps the last known numbers so the badge doesn't blank.
  const state = computed<AiCredits | null>(() => loggedIn.value ? query.data.value ?? null : null)

  // Everything still usable: the plan's budget and bought credits together.
  const pointsRemaining = computed(() => state.value?.pointsRemaining ?? 0)
  // The plan's monthly allotment and what is left of it. Bought AI credits
  // sit on top and are shown beside the meter, never inside it, so
  // "remaining" can't exceed "total".
  const pointsTotal = computed(() => state.value?.pointsTotal ?? 0)
  const planPointsRemaining = computed(() => Math.min(state.value?.planPointsRemaining ?? 0, pointsTotal.value))
  const creditPoints = computed(() => state.value?.creditPoints ?? 0)
  const fillRatio = computed(() => {
    const total = pointsTotal.value
    if (total <= 0) return 0
    return Math.max(0, Math.min(1, planPointsRemaining.value / total))
  })
  // Credits keep the AI running after the plan's budget: neither low nor empty then.
  const isLow = computed(() => creditPoints.value <= 0 && fillRatio.value > 0 && fillRatio.value < 0.1)
  // Unknown is never "used up": while this budget loads (a document's
  // workspace resolves after the page, so the budget switches from the
  // user's own to the workspace's), the zeros above are no reading.
  const isKnown = computed(() => state.value !== null)
  const isExhausted = computed(() => isKnown.value && creditPoints.value <= 0 && fillRatio.value <= 0)
  const isFreeAllowanceExhausted = computed(() => state.value?.freeAllowance?.exhausted === true)
  // Team / Business workspace: the member's AI runs on the
  // workspace's budget. A member can't buy their way out of an empty
  // team budget or their own member limit, the AIPromptBar says "ask an
  // admin" instead of "upgrade".
  const attribution = computed(() => state.value?.attribution ?? 'user')
  const isWorkspaceShared = computed(() => attribution.value === 'workspace')
  const isTeamBudgetExhausted = computed(() => state.value?.workspace?.teamExhausted === true)
  // A workspace admin can add seats or buy AI Points for the pool.
  const canManageWorkspaceBudget = computed(() => state.value?.workspace?.canManage === true)

  return {
    state,
    pointsRemaining,
    pointsTotal,
    planPointsRemaining,
    creditPoints,
    fillRatio,
    isLow,
    isKnown,
    isExhausted,
    isFreeAllowanceExhausted,
    attribution,
    isWorkspaceShared,
    isTeamBudgetExhausted,
    canManageWorkspaceBudget,
    refresh
  }
}

/** Where a Pro user buys extra AI Points (the profile's AI Points card). */
export const BUY_AI_POINTS_ROUTE = '/settings/profile#ai-points'
