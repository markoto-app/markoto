<script setup lang="ts">
import { STATS_RANGES, type AiStats, type ContentStats, type OpsStats, type OverviewStats, type RevenueStats, type StatsRange, type UsersStats } from '~~/shared/contracts/adminStats'
import { ADMIN_STATS_TABS, useAdminStatsQuery, type AdminStatsTab } from '~/queries/adminStats'

// Operator dashboard: product, revenue and usage stats of this instance.
// Admin-gated on the server (`/api/admin/stats/*`); the page also sends
// non-admins away so the layout never shows. Tab and range live in the
// URL, so a view can be shared with another admin.

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const { loggedIn } = useUserSession()
const { primaryLoginPath } = useInstanceConfig()
const { status: accountStatus } = useAccountStatus()

useHead({ title: () => t('adminStats.pageTitle') })

if (import.meta.client) {
  watchEffect(() => {
    if (!loggedIn.value) {
      globalThis.location.href = primaryLoginPath.value ?? '/'
    } else if (accountStatus.value && !accountStatus.value.isAdmin) {
      void router.push('/')
    }
  })
}

const isAdmin = computed(() => loggedIn.value && accountStatus.value?.isAdmin === true)

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

const tab = computed<AdminStatsTab>({
  get: () => pick(route.query.tab, ADMIN_STATS_TABS, 'overview'),
  set: v => void router.replace({ query: { ...route.query, tab: v } })
})
const range = computed<StatsRange>({
  get: () => pick(route.query.range, STATS_RANGES, '30'),
  set: v => void router.replace({ query: { ...route.query, range: v } })
})

const { data, error, isLoading } = useAdminStatsQuery(tab, range, isAdmin)

const tabItems = computed(() => ADMIN_STATS_TABS.map(value => ({ label: t(`adminStats.tabs.${value}`), value })))
</script>

<template>
  <div
    class="mx-auto max-w-6xl px-4 sm:px-6 py-8 sm:py-10"
    data-testid="admin-stats-page"
  >
    <div class="flex flex-wrap items-end justify-between gap-4 mb-6">
      <div>
        <h1 class="font-serif text-3xl font-normal tracking-tight text-default mb-1">
          {{ t('adminStats.title') }}
        </h1>
        <p class="text-sm text-muted">
          {{ t('adminStats.intro') }} {{ t('adminStats.updated') }}
        </p>
      </div>
      <UButton
        to="/admin/stats/investor"
        variant="outline"
        icon="i-lucide-presentation"
        data-testid="admin-stats-investor-link"
      >
        {{ t('adminStats.investorLink') }}
      </UButton>
    </div>

    <div
      class="flex flex-wrap items-center gap-1 mb-4"
      role="group"
      :aria-label="t('adminStats.range.label')"
    >
      <UButton
        v-for="r in STATS_RANGES"
        :key="r"
        size="sm"
        :variant="range === r ? 'solid' : 'ghost'"
        :aria-pressed="range === r"
        :data-testid="`admin-stats-range-${r}`"
        @click="range = r"
      >
        {{ t(`adminStats.range.${r}`) }}
      </UButton>
    </div>

    <UTabs
      v-model="tab"
      :items="tabItems"
      :content="false"
      variant="link"
      class="mb-6 overflow-x-auto"
    />

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
    <div
      v-else
      class="rounded-lg bg-muted p-3 sm:p-4"
    >
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
    </div>
  </div>
</template>
