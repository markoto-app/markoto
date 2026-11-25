<script setup lang="ts">
import { STATS_RANGES, type AiStats, type ContentStats, type OpsStats, type OverviewStats, type RevenueStats, type StatsRange, type UsersStats } from '~~/shared/contracts/adminStats'
import { ADMIN_STATS_TABS, useAdminStatsQuery, type AdminStatsTab } from '~/queries/adminStats'

// Operator dashboard: product, revenue and usage stats of this instance.
// Admin-gated on the server (`/api/admin/stats/*`); `useAdminGate` sends
// non-admins away. Tab and range live in the URL, so a view can be
// shared with another admin.

definePageMeta({ layout: 'admin' })

const { t } = useI18n()
const { isAdmin } = useAdminGate()

useHead({ title: () => t('adminStats.pageTitle') })

const tab = useRouteTab<AdminStatsTab>(ADMIN_STATS_TABS, 'overview')
const range = useRouteQueryChoice<StatsRange>('range', STATS_RANGES, '30')

const { data, error, isLoading } = useAdminStatsQuery(tab, range, isAdmin)

const tabItems = computed(() => ADMIN_STATS_TABS.map(value => ({ label: t(`adminStats.tabs.${value}`), value })))
</script>

<template>
  <div data-testid="admin-stats-page">
    <AdminPageHeader
      :title="t('adminStats.title')"
      :intro="`${t('adminStats.intro')} ${t('adminStats.updated')}`"
    >
      <template #actions>
        <UButton
          to="/admin/stats/investor"
          size="sm"
          variant="outline"
          icon="i-lucide-presentation"
          data-testid="admin-stats-investor-link"
        >
          {{ t('adminStats.investorLink') }}
        </UButton>
      </template>
    </AdminPageHeader>

    <div class="flex flex-col gap-3 mb-6 sm:mb-8 border-b border-default">
      <div
        class="flex flex-wrap items-center gap-1"
        role="group"
        :aria-label="t('adminStats.range.label')"
      >
        <span class="font-mono text-[11px] uppercase tracking-wider text-muted mr-2">
          {{ t('adminStats.range.label') }}
        </span>
        <UButton
          v-for="r in STATS_RANGES"
          :key="r"
          size="xs"
          :variant="range === r ? 'solid' : 'ghost'"
          :aria-pressed="range === r"
          :data-testid="`admin-stats-range-${r}`"
          @click="range = r"
        >
          {{ t(`adminStats.range.${r}`) }}
        </UButton>
      </div>
      <div class="overflow-x-auto -mb-px">
        <UTabs
          v-model="tab"
          :items="tabItems"
          :content="false"
          variant="link"
          color="neutral"
          class="min-w-max"
        />
      </div>
    </div>

    <div
      v-if="error"
      class="text-sm text-error"
      role="alert"
    >
      {{ t('adminStats.loadFailed') }}
    </div>
    <div
      v-else-if="isLoading || !data"
      class="text-sm text-muted"
    >
      {{ t('adminStats.loading') }}
    </div>
    <template v-else>
      <AdminStatsOverview
        v-if="tab === 'overview'"
        :data="data as OverviewStats"
      />
      <AdminStatsUsers
        v-else-if="tab === 'users'"
        :data="data as UsersStats"
        :range="range"
      />
      <AdminStatsContent
        v-else-if="tab === 'content'"
        :data="data as ContentStats"
        :range="range"
      />
      <AdminStatsAi
        v-else-if="tab === 'ai'"
        :data="data as AiStats"
        :range="range"
      />
      <AdminStatsRevenue
        v-else-if="tab === 'revenue'"
        :data="data as RevenueStats"
        :range="range"
      />
      <AdminStatsOps
        v-else
        :data="data as OpsStats"
        :range="range"
      />
    </template>
  </div>
</template>
