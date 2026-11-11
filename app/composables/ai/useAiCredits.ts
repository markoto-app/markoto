import type { ApiResponse } from '~/utils/api/client'

export type AiCredits = ApiResponse<'/api/ai/credits', 'get'>

/**
 * AI Points UI state. Backed by `useState` so every consumer (the
 * AIPromptBar badge, workspace overview) reads one snapshot — no
 * duplicate /api/ai/credits round-trips on mount.
 *
 * `refresh()` is the explicit invalidation point. Call it after AI
 * actions that consumed budget:
 *   - after an agentic prompt session ends
 *   - after a voice-prompt transcribe round-trips
 *   - after a generate_image tool call commits
 *   - after Stripe checkout returns (plan + budget reset)
 *
 * The `workspaceId` argument reads the budget that pays inside that
 * workspace: a Team / Business workspace's member limit + team pool,
 * else the user's own. One state per workspace (key
 * `ai-credits:<workspaceId>`), so the topbar badge (personal) and the
 * prompt bar of a workspace document never overwrite each other.
 */
export function useAiCredits(workspaceId?: MaybeRefOrGetter<string | null | undefined>) {
  const { loggedIn } = useUserSession()
  const { extractError } = useErrorHandler()
  // One entry per budget: '' = the user's own, else the workspace id.
  const states = useState<Record<string, AiCredits | null>>('ai-credits', () => ({}))
  const loadings = useState<Record<string, boolean>>('ai-credits-loading', () => ({}))
  const errors = useState<Record<string, string | null>>('ai-credits-error', () => ({}))
  const key = computed(() => toValue(workspaceId) ?? '')
  const state = computed<AiCredits | null>({
    get: () => states.value[key.value] ?? null,
    set: (v) => {
      states.value = { ...states.value, [key.value]: v }
    }
  })
  const loading = computed(() => loadings.value[key.value] === true)
  const error = computed(() => errors.value[key.value] ?? null)

  async function refresh(): Promise<void> {
    const k = key.value
    if (!loggedIn.value) {
      states.value = { ...states.value, [k]: null }
      return
    }
    loadings.value = { ...loadings.value, [k]: true }
    errors.value = { ...errors.value, [k]: null }
    try {
      const next = await apiFetch('/api/ai/credits', { query: k ? { workspaceId: k } : {} })
      states.value = { ...states.value, [k]: next }
    } catch (e) {
      errors.value = { ...errors.value, [k]: extractError(e).message }
      // Keep the last known state so a transient failure doesn't blank the badge.
    } finally {
      loadings.value = { ...loadings.value, [k]: false }
    }
  }

  // Auto-fetch on the first consumer of a budget, and when the
  // workspace becomes known (the editor learns it from /token).
  if (import.meta.client) {
    watch(key, () => {
      if (loggedIn.value && state.value === null && !loading.value) void refresh()
    }, { immediate: true })
  }

  watch(loggedIn, (isIn) => {
    if (!isIn) {
      states.value = {}
      return
    }
    void refresh()
  })

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
    loading,
    error,
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
