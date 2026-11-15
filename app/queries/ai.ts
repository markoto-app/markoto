// AI server state: AI Points per budget, which capabilities are available
// per workspace context, and the user's own providers (bring your own key).
import { defineQueryOptions, useMutation, useQuery, useQueryCache, type QueryCache } from '@pinia/colada'
import type { AiCapability } from '~~/shared/ai/providers'
import { apiFetch, type ApiCall, type ApiFetcher, type ApiResponse } from '~/utils/api/client'
import { withTransientRetry } from '~/utils/api/retry'
import { SESSION_SNAPSHOT } from './defaults'
import { invalidate } from './invalidate'

type AiAvailabilityResponse = ApiResponse<'/api/ai/availability', 'get'>

/** `null` = the user's own budget / no workspace context. */
type WorkspaceScope = string | null

export const aiKeys = {
  root: ['ai'] as const,
  /** Every budget; `creditsFor` is one of them. */
  credits: () => [...aiKeys.root, 'credits'] as const,
  creditsFor: (workspaceId: WorkspaceScope) => [...aiKeys.credits(), workspaceId] as const,
  availability: () => [...aiKeys.root, 'availability'] as const,
  availabilityFor: (workspaceId: WorkspaceScope) => [...aiKeys.availability(), workspaceId] as const,
  providers: () => [...aiKeys.root, 'providers'] as const
}

const aiCreditsQuery = defineQueryOptions(({ api, workspaceId }: { api: ApiFetcher, workspaceId: WorkspaceScope }) => ({
  key: aiKeys.creditsFor(workspaceId),
  // The budget lives in LiteLLM, which can still be starting (after a
  // deploy): ask again rather than leave the meter empty for the session.
  query: ({ signal }) => withTransientRetry(() => api('/api/ai/credits', { signal, query: workspaceId ? { workspaceId } : {} }), { signal }),
  ...SESSION_SNAPSHOT
}))

const aiAvailabilityQuery = defineQueryOptions(({ api, workspaceId }: { api: ApiFetcher, workspaceId: WorkspaceScope }) => ({
  key: aiKeys.availabilityFor(workspaceId),
  query: ({ signal }) => api('/api/ai/availability', { signal, query: workspaceId ? { workspaceId } : {} }),
  ...SESSION_SNAPSHOT
}))

const aiProvidersQuery = defineQueryOptions(({ api }: { api: ApiFetcher }) => ({
  key: aiKeys.providers(),
  query: ({ signal }) => api('/api/user/ai-providers', { signal })
}))

/**
 * Client-only like the snapshots it replaced: the server render never
 * knew them, so hydration starts from "unknown" on both sides.
 */
function useSignedInClient() {
  const { loggedIn } = useUserSession()
  return () => import.meta.client && loggedIn.value
}

export function useAiCreditsQuery(workspaceId: MaybeRefOrGetter<WorkspaceScope | undefined>) {
  const enabled = useSignedInClient()
  return useQuery(() => ({
    ...aiCreditsQuery({ api: apiFetch, workspaceId: toValue(workspaceId) ?? null }),
    enabled: enabled()
  }))
}

export function useAiAvailabilityQuery(workspaceId: MaybeRefOrGetter<WorkspaceScope | undefined>) {
  const enabled = useSignedInClient()
  return useQuery(() => ({
    ...aiAvailabilityQuery({ api: apiFetch, workspaceId: toValue(workspaceId) ?? null }),
    enabled: enabled(),
    // Entering another workspace context keeps the previous answer on
    // screen until this one arrives, instead of flashing "unknown".
    placeholderData: (previous: AiAvailabilityResponse | undefined) => previous
  }))
}

export function useAiProvidersQuery() {
  const enabled = useSignedInClient()
  return useQuery(() => ({ ...aiProvidersQuery({ api: apiFetch }), enabled: enabled() }))
}

/** A provider or the model tier changed: what the user can use changed with it. */
function invalidateProviderState(cache: QueryCache) {
  return invalidate(cache, aiKeys.providers(), aiKeys.availability())
}

type ProviderBody = NonNullable<ApiCall<'/api/user/ai-providers/:capability', 'put'>['body']>

export function useSaveAiProvider() {
  const cache = useQueryCache()
  return useMutation({
    mutation: ({ capability, body }: { capability: AiCapability, body: ProviderBody }) =>
      apiFetch('/api/user/ai-providers/:capability', { method: 'put', path: { capability }, body }),
    // Not awaited: the card reports the result at once, the lists follow.
    onSuccess: () => { void invalidateProviderState(cache) }
  })
}

/** Verifying records the result on the stored provider (the card's status line). */
export function useVerifyAiProvider() {
  const cache = useQueryCache()
  return useMutation({
    mutation: (capability: AiCapability) =>
      apiFetch('/api/user/ai-providers/:capability/verify', { method: 'post', path: { capability } }),
    // Not awaited: the card reports the result at once, the lists follow.
    onSuccess: () => { void invalidateProviderState(cache) }
  })
}

export function useRemoveAiProvider() {
  const cache = useQueryCache()
  return useMutation({
    mutation: (capability: AiCapability) =>
      apiFetch('/api/user/ai-providers/:capability', { method: 'delete', path: { capability } }),
    // Not awaited: the card reports the result at once, the lists follow.
    onSuccess: () => { void invalidateProviderState(cache) }
  })
}

export function useSetAiModelTier() {
  const cache = useQueryCache()
  return useMutation({
    mutation: (tier: 'fast' | 'strong') => apiFetch('/api/user/ai-model', { method: 'put', body: { tier } }),
    // Awaited: the radio stays disabled until the page shows the new tier.
    onSuccess: () => invalidateProviderState(cache)
  })
}

/** AI was used on this budget (a session ended, a voice prompt). */
export function useInvalidateAiCredits(workspaceId: MaybeRefOrGetter<WorkspaceScope | undefined>) {
  const cache = useQueryCache()
  return () => invalidate(cache, aiKeys.creditsFor(toValue(workspaceId) ?? null))
}

export function useInvalidateAiAvailability() {
  const cache = useQueryCache()
  return () => invalidate(cache, aiKeys.availability())
}
