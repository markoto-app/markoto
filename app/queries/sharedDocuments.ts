// Documents shared with the caller as a workspace GUEST
// (`/api/user/shared-documents`): a guest's only view of a workspace. The
// editor's left panel lists those of the open document's workspace.
import { defineQueryOptions, useQuery } from '@pinia/colada'
import { apiFetch, type ApiFetcher } from '~/utils/api/client'
import { sharedEnabled } from './sharedEnabled'

const sharedDocumentKeys = {
  root: ['shared-documents'] as const
}

const sharedDocumentsQuery = defineQueryOptions(({ api }: { api: ApiFetcher }) => ({
  key: sharedDocumentKeys.root,
  query: ({ signal }) => api('/api/user/shared-documents', { signal }),
  // A share can be added or taken back at any time by the workspace.
  staleTime: 0
}))

export function useSharedDocuments(active: MaybeRefOrGetter<boolean> = true) {
  const { loggedIn } = useUserSession()
  const wanted = sharedEnabled('shared-documents', active)
  return useQuery(() => ({
    ...sharedDocumentsQuery({ api: apiFetch }),
    enabled: import.meta.client && loggedIn.value && wanted()
  }))
}
