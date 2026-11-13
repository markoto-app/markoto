// Query defaults, decided once (colada.options.ts hands QUERY_DEFAULTS to
// the PiniaColada plugin; the presets below are spread into single queries).
// See docs/contributing/client-data.md.
import type { UseQueryOptionsGlobal } from '@pinia/colada'

/**
 * Every query unless it says otherwise.
 *
 * - `staleTime` 5 s: long enough that the several components mounting
 *   together on one page (theme panel + new-document dialog, the editor's
 *   AI entry points) share one request, short enough that opening a view
 *   later still loads current data, as the per-mount fetches did before.
 * - No refetch on window focus / reconnect: nothing in the app did that
 *   before, and turning it on would add requests the server never saw.
 *   Freshness comes from mutations invalidating their keys instead.
 */
export const QUERY_DEFAULTS = {
  staleTime: 5_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false
} satisfies UseQueryOptionsGlobal

/**
 * Per-session snapshots (plan + limits, account status, AI points and
 * availability): fetched once by the first consumer, kept for the life of
 * the page and refreshed only through their invalidation points (an AI
 * session ending, a plan change, a provider saved…). Never stale on mount,
 * never garbage-collected: a consumer mounting later (a popover, a dialog)
 * must not refetch what the topbar already loaded.
 */
export const SESSION_SNAPSHOT = {
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: false
} as const

/**
 * Instance configuration (prices, tier caps): changes with a deploy or a
 * Stripe price edit, never because of something the visitor did.
 */
export const INSTANCE_CONFIG = {
  staleTime: 10 * 60_000
} as const
