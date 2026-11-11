import type { PlanName } from '~~/shared/config/tiers'

export interface UserBilling {
  plan: PlanName
  periodStart: string
  periodEnd: string
  // Caps are echoed alongside the counted values so the UI can compare
  // `used >= limit` without importing TIERS.
  ownedWorkspaces: number
  workspacesOwnedLimit: number
  knowledgeFilesUsed: number
  knowledgeFilesLimit: number
  knowledgeBytesUsed: number
  knowledgeBytesPerUserLimit: number
  /** Document image storage (pending uploads included) vs. the per-user quota. */
  imageBytesUsed: number
  imageBytesPerUserLimit: number
  /** AI credit top-ups; null with billing off. */
  credits?: import('~/utils/billing/aiCredits').CreditBalanceView | null
  /** Workspaces whose Team / Business plan covers the user inside them. */
  coveringWorkspaces?: Array<{ workspaceId: string, name: string, plan: 'team' | 'business' }>
}

/**
 * Shared billing state. Backed by `useState` so every consumer (topbar
 * badge, AI prompt bar, workspace billing toggle, pricing page) reads
 * one snapshot — no duplicate /api/user/billing round-trips on mount.
 *
 * `refresh()` is the explicit invalidation point. Call it after actions
 * that might change the state:
 *   - after an AI session ends
 *   - after Stripe checkout returns (plan may have changed)
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
      // Keep the last known state so a transient failure doesn't erase the plan badge.
    } finally {
      loading.value = false
    }
  }

  // Fetched once by the first consumer. No polling: the counters only change
  // on AI activity, and the prompt bar's session-end hook calls refresh().
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

  // "At cap" is defined here once so every gated control disables in lockstep.
  // With no billing data (anonymous / fetch failed) every flag is false rather
  // than disabling actions for unknown callers; the server enforces regardless.
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
  // AI-credit exhaustion lives in `useAiCredits`; this only owns structural caps.

  return {
    billing: state,
    loading,
    error,
    refresh,
    workspaceCapReached,
    knowledgeFilesCapReached,
    knowledgeBytesCapReached
  }
}
