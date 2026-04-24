import type { PlanName } from '~~/shared/config/tiers'

export interface UserBilling {
  plan: PlanName
  // Credits (AI interactions)
  interactionsRemaining: number
  interactionsLimit: number
  periodStart: string
  periodEnd: string
  // Structural caps — echoed alongside the counted values so the UI
  // can do `used >= limit` checks without a separate TIERS import.
  ownedWorkspaces: number
  workspacesOwnedLimit: number
  knowledgeFilesUsed: number
  knowledgeFilesLimit: number
  knowledgeBytesUsed: number
  knowledgeBytesPerUserLimit: number
}

/**
 * Shared billing state. Backed by `useState` so every consumer (topbar
 * badge, AI prompt bar, workspace billing toggle, pricing page) reads
 * one snapshot — no duplicate /api/user/billing round-trips on mount.
 *
 * `refresh()` is the explicit invalidation point. Call it after actions
 * that might change the state:
 *   - after an AI session ends (interactions consumed)
 *   - after a Stripe webhook might have landed (future phase 7)
 */
export function useBilling() {
  const { loggedIn } = useUserSession()
  const state = useState<UserBilling | null>('billing', () => null)
  const loading = useState<boolean>('billing-loading', () => false)
  const error = useState<string | null>('billing-error', () => null)

  async function refresh(): Promise<void> {
    if (!loggedIn.value) {
      state.value = null
      return
    }
    loading.value = true
    error.value = null
    try {
      state.value = await $fetch<UserBilling>('/api/user/billing')
    } catch (e) {
      const err = e as { message?: string, data?: { message?: string } }
      error.value = err?.data?.message ?? err?.message ?? 'Could not load billing info'
      // Keep the last-known state so a transient failure doesn't erase
      // the plan badge mid-session; we just stop refreshing until the
      // next explicit refresh() call.
    } finally {
      loading.value = false
    }
  }

  // Auto-fetch once on first consumer, tracked via `state` being null.
  // Subsequent consumers share the cached state. No interval polling —
  // the counter only changes on AI activity, and the prompt bar's
  // session-end hook triggers refresh() explicitly.
  if (import.meta.client && loggedIn.value && state.value === null && !loading.value) {
    void refresh()
  }

  // Keep billing state in sync with login changes: cleared on logout,
  // re-fetched on login.
  watch(loggedIn, (isIn) => {
    if (!isIn) {
      state.value = null
      return
    }
    void refresh()
  })

  // Derived "at-cap" flags. Every cap-gated UI surface reads from
  // these instead of re-doing the math, so "at cap" is defined in
  // exactly one place and every button disables in lockstep.
  // - `null` billing (anonymous / fetch failed) → `false` for all
  //   flags: we don't want to accidentally disable actions for
  //   callers we know nothing about. Server enforcement is the
  //   second line of defense in that case.
  const workspaceCapReached = computed(() => {
    const b = state.value
    if (!b) return false
    return b.ownedWorkspaces >= b.workspacesOwnedLimit
  })
  const knowledgeFilesCapReached = computed(() => {
    const b = state.value
    if (!b) return false
    return b.knowledgeFilesUsed >= b.knowledgeFilesLimit
  })
  const knowledgeBytesCapReached = computed(() => {
    const b = state.value
    if (!b) return false
    return b.knowledgeBytesUsed >= b.knowledgeBytesPerUserLimit
  })
  const creditsExhausted = computed(() => {
    const b = state.value
    if (!b) return false
    return b.interactionsRemaining <= 0
  })

  return {
    billing: state,
    loading,
    error,
    refresh,
    // Derived flags
    workspaceCapReached,
    knowledgeFilesCapReached,
    knowledgeBytesCapReached,
    creditsExhausted
  }
}
