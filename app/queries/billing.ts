// Billing server state: the caller's plan + limits snapshot
// (`/api/user/billing`) and the instance's price / tier tables.
import { defineQueryOptions, useMutation, useQuery, useQueryCache } from '@pinia/colada'
import type { BillingInterval } from '~~/shared/config/pricing'
import { apiFetch, useApi, type ApiFetcher } from '~/utils/api/client'
import { aiKeys } from './ai'
import { INSTANCE_CONFIG, SESSION_SNAPSHOT } from './defaults'
import { invalidate } from './invalidate'

export const billingKeys = {
  root: ['billing'] as const,
  /** The signed-in user's plan, usage counters and limits. */
  user: () => [...billingKeys.root, 'user'] as const,
  prices: () => [...billingKeys.root, 'prices'] as const,
  tiers: () => [...billingKeys.root, 'tiers'] as const
}

const userBillingQuery = defineQueryOptions(({ api }: { api: ApiFetcher }) => ({
  key: billingKeys.user(),
  query: ({ signal }) => api('/api/user/billing', { signal }),
  ...SESSION_SNAPSHOT
}))

export const planPricesQuery = defineQueryOptions(({ api }: { api: ApiFetcher }) => ({
  key: billingKeys.prices(),
  query: ({ signal }) => api('/api/billing/prices', { signal }),
  ...INSTANCE_CONFIG
}))

const tierLimitsQuery = defineQueryOptions(({ api }: { api: ApiFetcher }) => ({
  key: billingKeys.tiers(),
  query: ({ signal }) => api('/api/billing/tiers', { signal }),
  ...INSTANCE_CONFIG
}))

/**
 * The signed-in user's billing snapshot, client-side only (the server
 * render never had it, so first paint and hydration agree on "unknown").
 */
export function useUserBillingQuery() {
  const { loggedIn } = useUserSession()
  return useQuery(() => ({
    ...userBillingQuery({ api: apiFetch }),
    enabled: import.meta.client && loggedIn.value
  }))
}

/**
 * Plan prices, usable during the server render: `useApi()` forwards the
 * request's cookies there, and the result is hydrated from the payload.
 */
export function usePlanPricesQuery() {
  const api = useApi()
  return useQuery(() => planPricesQuery({ api }))
}

export function useTierLimitsQuery() {
  const api = useApi()
  return useQuery(() => tierLimitsQuery({ api }))
}

/**
 * The plan changed (checkout returned, an in-place upgrade, a top-up):
 * the limits AND every AI budget that follows the plan are out of date.
 */
export function useInvalidatePlan() {
  const cache = useQueryCache()
  return () => invalidate(cache, billingKeys.user(), aiKeys.credits())
}

/** Usage counters changed (a workspace created or deleted, an upload). */
export function useInvalidateUsage() {
  const cache = useQueryCache()
  return () => invalidate(cache, billingKeys.user())
}

/**
 * Switch the caller's live Pro subscription between monthly and annual
 * billing (the server swaps the price in place). The plan snapshot is
 * re-read before the caller continues, so the page shows the new period.
 * Without a live subscription the server answers with a Checkout URL
 * instead, which the caller follows.
 */
export function useSwitchProInterval() {
  const cache = useQueryCache()
  return useMutation({
    mutation: (interval: BillingInterval) =>
      apiFetch('/api/billing/checkout', { method: 'post', body: { plan: 'pro', interval, acceptPaidTerms: true } }),
    onSuccess: () => invalidate(cache, billingKeys.user(), aiKeys.credits())
  })
}

/**
 * Take back the cancellation of the caller's Pro plan while it still
 * runs; it renews again. The plan snapshot is re-read so the page shows
 * the renewal date instead of the end date.
 */
export function useResumeProPlan() {
  const cache = useQueryCache()
  return useMutation({
    mutation: () => apiFetch('/api/billing/resume', { method: 'post' }),
    onSuccess: () => invalidate(cache, billingKeys.user())
  })
}
