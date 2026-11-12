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
 * the user's own. Each budget is its own cache entry, so the topbar badge
 * (personal) and the prompt bar of a workspace document never overwrite
 * each other.
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

  const pointsRemaining = computed(() => state.value?.pointsRemaining ?? 0)
  const pointsTotal = computed(() => state.value?.pointsTotal ?? 0)
  const fillRatio = computed(() => {
    const total = pointsTotal.value
    if (total <= 0) return 0
    return Math.max(0, Math.min(1, pointsRemaining.value / total))
  })
  const isLow = computed(() => fillRatio.value > 0 && fillRatio.value < 0.1)
  const isExhausted = computed(() => fillRatio.value <= 0)
  const isFreeAllowanceExhausted = computed(() => state.value?.freeAllowance?.exhausted === true)
  // Team / Business workspace: the member's AI runs on the
  // workspace's budget. A member can't buy their way out of an empty
  // team budget or their own member limit — the AIPromptBar says "ask an
  // admin" instead of "upgrade".
  const attribution = computed(() => state.value?.attribution ?? 'user')
  const isWorkspaceShared = computed(() => attribution.value === 'workspace')
  const isTeamBudgetExhausted = computed(() => state.value?.workspace?.teamExhausted === true)

  return {
    state,
    pointsRemaining,
    pointsTotal,
    fillRatio,
    isLow,
    isExhausted,
    isFreeAllowanceExhausted,
    attribution,
    isWorkspaceShared,
    isTeamBudgetExhausted,
    refresh
  }
}
