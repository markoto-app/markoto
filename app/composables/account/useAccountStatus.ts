// Account-status state shared via `useState`: the deletion-grace banner, the
// settings page and the policy-acceptance prompt read one snapshot from a
// single /api/user/account-status fetch.
//
// Refreshed on first mount of any consumer, on login, and explicitly after
// requesting/cancelling deletion and after accepting a policy version.

export interface AccountStatus {
  isAdmin: boolean
  email: string | null
  locale: string | null
  age: { confirmedAt: string | null, confirmationRequired: boolean }
  deletion: { requestedAt: string | null, graceUntil: string | null, pending: boolean }
  policy: {
    privacy: PolicyAcceptance
    tos: PolicyAcceptance
    dpa: PolicyAcceptance
  }
}

export interface PolicyAcceptance {
  currentVersion: number
  acceptedVersion: number | null
  acceptedLocale: string | null
  acceptanceRequired: boolean
}

export function useAccountStatus() {
  const { loggedIn } = useUserSession()
  const state = useState<AccountStatus | null>('account-status', () => null)
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
      state.value = await $fetch<AccountStatus>('/api/user/account-status')
    } catch (e) {
      const err = e as { message?: string, data?: { message?: string } }
      error.value = err?.data?.message ?? err?.message ?? 'Could not load account status'
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
