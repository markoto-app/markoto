// Account status for the deletion-grace banner, the settings page, the
// policy-acceptance prompt and the admin pages: one cached query
// (app/queries/account.ts), fetched by the first consumer after mount.
// `refresh()` after requesting/cancelling deletion or accepting a policy.

import type { ApiResponse } from '~/utils/api/client'
import { useAccountStatusQuery, useInvalidateAccountStatus } from '~/queries/account'

export type AccountStatus = ApiResponse<'/api/user/account-status', 'get'>

export function useAccountStatus() {
  const { loggedIn } = useUserSession()
  const query = useAccountStatusQuery()
  const refresh = useInvalidateAccountStatus()

  // Signed out → nothing, even if a previous session's answer is cached.
  const status = computed<AccountStatus | null>(() => loggedIn.value ? query.data.value ?? null : null)
  // Signed in and not answered yet: show a placeholder, never a default value.
  const pending = computed(() => loggedIn.value && query.status.value === 'pending')

  return { status, pending, refresh }
}
