// Account-status state shared via `useState`: the deletion-grace banner, the
// settings page and the policy-acceptance prompt read one snapshot from a
// single /api/user/account-status fetch.
//
// Refreshed on first mount of any consumer, on login, and explicitly after
// requesting/cancelling deletion and after accepting a policy version.

import type { ApiResponse } from '~/utils/api/client'

export type AccountStatus = ApiResponse<'/api/user/account-status', 'get'>

export function useAccountStatus() {
  const { loggedIn } = useUserSession()
  const state = useState<AccountStatus | null>('account-status', () => null)
  const { extractError } = useErrorHandler()
  const loading = useState<boolean>('account-status-loading', () => false)
  const error = useState<string | null>('account-status-error', () => null)

  async function refresh(): Promise<void> {
    if (!loggedIn.value) {
      state.value = null
      return
    }
    loading.value = true
    error.value = null
    try {
      state.value = await apiFetch('/api/user/account-status')
    } catch (e) {
      error.value = extractError(e).message
    } finally {
      loading.value = false
    }
  }

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

  return {
    status: readonly(state),
    loading: readonly(loading),
    error: readonly(error),
    refresh
  }
}
