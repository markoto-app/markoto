import type { ApiResponse } from '~/utils/api/client'
import { useInvalidateUsage, useUserBillingQuery } from '~/queries/billing'

export type UserBilling = ApiResponse<'/api/user/billing', 'get'>

/**
 * The caller's plan, usage counters and limits: one cached query
 * (app/queries/billing.ts) shared by the topbar badge, the AI prompt bar,
 * the dashboard, the profile and pricing pages. Mutations that change the
 * counters invalidate it themselves (workspace create / delete, plan
 * change); `refresh()` is for the remaining moments — an AI session ending,
 * the usage popover opening, Stripe returning.
 */
export function useBilling() {
  const { loggedIn } = useUserSession()
  const query = useUserBillingQuery()
  const refresh = useInvalidateUsage()

  // A failed refetch keeps the last known data, so the plan badge doesn't
  // blink away on a transient error.
  const billing = computed<UserBilling | null>(() => loggedIn.value ? query.data.value ?? null : null)

  // "At cap" is defined here once so every gated control disables in lockstep.
  // With no billing data (anonymous / fetch failed) it is false rather than
  // disabling actions for unknown callers; the server enforces regardless.
  // AI-credit exhaustion lives in `useAiCredits`.
  const workspaceCapReached = computed(() => {
    const b = billing.value
    return b !== null && b.ownedWorkspaces >= b.workspacesOwnedLimit
  })

  return { billing, refresh, workspaceCapReached }
}
