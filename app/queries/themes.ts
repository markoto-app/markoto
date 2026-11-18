// The signed-in user's saved theme presets (`/api/themes`): read by the
// theme panel, the new-document dialog and the workspace default-theme
// picker; written by the save / edit / delete dialogs and "Create a design
// from a document".
import { defineQueryOptions, useMutation, useQuery, useQueryCache } from '@pinia/colada'
import { apiFetch, type ApiCall, type ApiFetcher } from '~/utils/api/client'
import { invalidate } from './invalidate'
import { sharedEnabled } from './sharedEnabled'

export const themeKeys = {
  root: ['themes'] as const,
  saved: () => [...themeKeys.root, 'saved'] as const
}

const savedThemesQuery = defineQueryOptions(({ api }: { api: ApiFetcher }) => ({
  key: themeKeys.saved(),
  query: ({ signal }) => api('/api/themes', { signal })
}))

/**
 * Anonymous viewers have no saved themes (the route answers 401): the
 * query stays off and the list empty. Loaded after mount, as every reader
 * did before. `active` defers it further for a component that stays
 * mounted while hidden (the new-document dialog loads on open).
 */
export function useSavedThemes(active: MaybeRefOrGetter<boolean> = true) {
  const { loggedIn } = useUserSession()
  // The same `enabled` for every reader of the shared entry (see `sharedEnabled`).
  const wanted = sharedEnabled('themes.saved', active)
  const query = useQuery(() => ({
    ...savedThemesQuery({ api: apiFetch }),
    enabled: () => import.meta.client && loggedIn.value && wanted()
  }))
  // A failed load leaves the list empty; the built-in presets still work.
  const themes = computed(() => loggedIn.value ? query.data.value?.themes ?? [] : [])
  return { themes, isLoading: query.isLoading }
}

type CreateBody = NonNullable<ApiCall<'/api/themes', 'post'>['body']>
type UpdateBody = NonNullable<ApiCall<'/api/themes/:themeId', 'patch'>['body']>

// Awaited invalidation: the dialogs close and the caller toasts once the
// list on screen already shows the change.
export function useCreateSavedTheme() {
  const cache = useQueryCache()
  return useMutation({
    mutation: (body: CreateBody) => apiFetch('/api/themes', { method: 'post', body }),
    onSuccess: () => invalidate(cache, themeKeys.root)
  })
}

export function useUpdateSavedTheme() {
  const cache = useQueryCache()
  return useMutation({
    mutation: ({ themeId, body }: { themeId: string, body: UpdateBody }) =>
      apiFetch('/api/themes/:themeId', { method: 'patch', path: { themeId }, body }),
    onSuccess: () => invalidate(cache, themeKeys.root)
  })
}

export function useDeleteSavedTheme() {
  const cache = useQueryCache()
  return useMutation({
    mutation: (themeId: string) => apiFetch('/api/themes/:themeId', { method: 'delete', path: { themeId } }),
    onSuccess: () => invalidate(cache, themeKeys.root)
  })
}
