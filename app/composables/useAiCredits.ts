import type { PlanName } from '~~/shared/config/tiers'

export interface AiCredits {
  pointsRemaining: number
  pointsTotal: number
  plan: PlanName
  periodEnd: string
  attribution: 'user' | 'workspace'
  /**
   * The shared monthly free-tier pool (hosted SaaS): null when the plan
   * isn't pooled. `exhausted` = nobody on the free tier can use the
   * platform-paid AI until `resetsAt`, whatever their own points say.
   */
  freeAllowance?: { pooled: boolean, exhausted: boolean, resetsAt: string | null } | null
}

/**
 * AI Points UI state. Backed by `useState` so every consumer (the
 * AIPromptBar badge, workspace overview, the hypothetical /pricing
 * page upsell, etc.) reads one snapshot — no duplicate /api/ai/credits
 * round-trips on mount.
 *
 * `refresh()` is the explicit invalidation point. Call it after AI
 * actions that consumed budget:
 *   - after an agentic prompt session ends
 *   - after a voice-prompt transcribe round-trips
 *   - after a generate_image tool call commits
 *   - after Stripe checkout returns (plan + budget reset)
 *
 * The `workspaceId` argument switches the displayed pool when the
 * user is on a `(+)` workspace so they see the SPONSOR's pool, not
 * their own.
 */
export function useAiCredits(workspaceId?: string | null) {
  const { loggedIn } = useUserSession()
  const state = useState<AiCredits | null>('ai-credits', () => null)
  const loading = useState<boolean>('ai-credits-loading', () => false)
  const error = useState<string | null>('ai-credits-error', () => null)

  async function refresh(): Promise<void> {
    if (!loggedIn.value) {
      state.value = null
      return
    }
    loading.value = true
    error.value = null
    try {
      const query: Record<string, string> = {}
      if (workspaceId) query.workspaceId = workspaceId
      state.value = await $fetch<AiCredits>('/api/ai/credits', { query })
    } catch (e) {
      const err = e as { message?: string, data?: { message?: string } }
      error.value = err?.data?.message ?? err?.message ?? 'Could not load AI credits'
      // Keep last-known state so a transient failure doesn't blank
      // the badge mid-session.
    } finally {
      loading.value = false
    }
  }

  // Auto-fetch once on first consumer.
  if (import.meta.client && loggedIn.value && state.value === null && !loading.value) {
    void refresh()
  }

  watch(loggedIn, (isIn) => {
    if (!isIn) {
      state.value = null
      return
    }
    void refresh()
  })

  // Derived "low" + "exhausted" flags for visual cue switching.
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
  // Phase 7: when (+) is active for this workspace the displayed pool
  // is the SPONSOR's. Members can't upgrade themselves out of an
  // exhausted shared budget — only the workspace owner can. Surface
  // this so the AIPromptBar can swap its toast/CTA copy.
  const attribution = computed(() => state.value?.attribution ?? 'user')
  const isWorkspaceShared = computed(() => attribution.value === 'workspace')

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
    refresh
  }
}
