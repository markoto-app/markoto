// Account server state: deletion grace period, policy acceptance, admin flag
// (`/api/user/account-status`).
import { defineQueryOptions, useQuery, useQueryCache } from '@pinia/colada'
import { apiFetch, type ApiFetcher } from '~/utils/api/client'
import { SESSION_SNAPSHOT } from './defaults'
import { invalidate } from './invalidate'

export const accountKeys = {
  root: ['account'] as const,
  status: () => [...accountKeys.root, 'status'] as const
}

const accountStatusQuery = defineQueryOptions(({ api }: { api: ApiFetcher }) => ({
  key: accountKeys.status(),
  query: ({ signal }) => api('/api/user/account-status', { signal }),
  ...SESSION_SNAPSHOT
}))

/** Client-only, as before: the server render shows no banner or gate. */
export function useAccountStatusQuery() {
  const { loggedIn } = useUserSession()
  return useQuery(() => ({
    ...accountStatusQuery({ api: apiFetch }),
    enabled: import.meta.client && loggedIn.value
  }))
}

/** A policy was accepted, deletion requested or cancelled. */
export function useInvalidateAccountStatus() {
  const cache = useQueryCache()
  return () => invalidate(cache, accountKeys.status())
}
