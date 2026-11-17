// Admin product stats (`/admin/stats`): one query per tab and range. The
// server caches each answer for a minute, so the client keeps it as long.
import { useQuery } from '@pinia/colada'
import type { MaybeRefOrGetter } from 'vue'
import type { AiStats, ContentStats, OpsStats, OverviewStats, RevenueStats, StatsBucket, StatsRange, UsersStats } from '~~/shared/contracts/adminStats'
import { apiFetch } from '~/utils/api/client'

export const ADMIN_STATS_TABS = ['overview', 'users', 'content', 'ai', 'revenue', 'ops'] as const
export type AdminStatsTab = typeof ADMIN_STATS_TABS[number]

const adminStatsKeys = {
  root: ['admin-stats'] as const,
  tab: (tab: AdminStatsTab, range: StatsRange, bucket: StatsBucket | null) => [...adminStatsKeys.root, tab, range, bucket ?? 'auto'] as const
}

const STATS_STALE_MS = 60_000

/** One tab's answer; the page narrows it by the tab it asked for. */
export type AdminStatsData = OverviewStats | UsersStats | ContentStats | AiStats | RevenueStats | OpsStats

function fetchTab(tab: AdminStatsTab, range: StatsRange, bucket: StatsBucket | null, signal: AbortSignal): Promise<AdminStatsData> {
  return requestTab(tab, range, bucket, signal) as Promise<unknown> as Promise<AdminStatsData>
}

function requestTab(tab: AdminStatsTab, range: StatsRange, bucket: StatsBucket | null, signal: AbortSignal) {
  const query = bucket ? { range, bucket } : { range }
  switch (tab) {
    case 'overview': return apiFetch('/api/admin/stats/overview', { query, signal })
    case 'users': return apiFetch('/api/admin/stats/users', { query, signal })
    case 'content': return apiFetch('/api/admin/stats/content', { query, signal })
    case 'ai': return apiFetch('/api/admin/stats/ai', { query, signal })
    case 'revenue': return apiFetch('/api/admin/stats/revenue', { query, signal })
    case 'ops': return apiFetch('/api/admin/stats/ops', { query, signal })
  }
}

/** One tab's stats; client-side only, and only for admins (`enabled`). */
export function useAdminStatsQuery(
  tab: MaybeRefOrGetter<AdminStatsTab>,
  range: MaybeRefOrGetter<StatsRange>,
  enabled: MaybeRefOrGetter<boolean>,
  bucket: MaybeRefOrGetter<StatsBucket | null> = null
) {
  return useQuery(() => {
    const t = toValue(tab)
    const r = toValue(range)
    const b = toValue(bucket)
    return {
      key: adminStatsKeys.tab(t, r, b),
      query: ({ signal }) => fetchTab(t, r, b, signal),
      staleTime: STATS_STALE_MS,
      enabled: import.meta.client && toValue(enabled)
    }
  })
}
