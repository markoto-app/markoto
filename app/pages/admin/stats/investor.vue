<script setup lang="ts">
import type { OverviewStats, RevenueStats, UsersStats } from '~~/shared/contracts/adminStats'
import { useAdminStatsQuery } from '~/queries/adminStats'

// One-page investor summary: the key numbers and 12 months of monthly
// charts, laid out to print on A4 (the browser's "Save as PDF").

const { t, locale } = useI18n()
const router = useRouter()
const { loggedIn } = useUserSession()
const { primaryLoginPath } = useInstanceConfig()
const { status: accountStatus } = useAccountStatus()

useHead({ title: () => `${t('adminStats.investorTitle')} · Admin` })

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
const overviewQuery = useAdminStatsQuery('overview', '365', isAdmin, 'month')
const usersQuery = useAdminStatsQuery('users', '365', isAdmin, 'month')
const revenueQuery = useAdminStatsQuery('revenue', '30', isAdmin)

const overview = computed(() => overviewQuery.data.value as OverviewStats | undefined)
const users = computed(() => usersQuery.data.value as UsersStats | undefined)
const revenue = computed(() => revenueQuery.data.value as RevenueStats | undefined)
const failed = computed(() => Boolean(overviewQuery.error.value || usersQuery.error.value || revenueQuery.error.value))

const n = (v: number) => statsCount(v, locale.value)
const usd = (v: number) => statsMoney(v, 'usd', locale.value)
const today = new Intl.DateTimeFormat(locale.value, { dateStyle: 'long' }).format(new Date())
const months = (pts: Array<{ t: string }>) => pts.map(p => statsBucketLabel(p.t, 'month', locale.value))

function print(): void {
  globalThis.print()
}
</script>

<template>
  <div
    class="mx-auto max-w-5xl px-4 sm:px-6 py-8 print:p-0 print:max-w-none"
    data-testid="admin-stats-investor"
  >
    <div class="flex flex-wrap items-center justify-between gap-3 mb-6 print:hidden">
      <UButton
        to="/admin/stats"
        variant="ghost"
        icon="i-lucide-arrow-left"
      >
        {{ t('adminStats.back') }}
      </UButton>
      <UButton
        icon="i-lucide-printer"
        data-testid="admin-stats-print"
        @click="print"
      >
        {{ t('adminStats.print') }}
      </UButton>
    </div>

    <h1 class="font-serif text-3xl font-normal tracking-tight text-default mb-1">
      {{ t('adminStats.investorTitle') }}
    </h1>
    <p class="text-sm text-muted mb-6">
      {{ t('adminStats.investor.subtitle', { date: today }) }}
    </p>

    <div
      v-if="failed"
      class="text-sm text-error"
      role="alert"
    >
      {{ t('adminStats.loadFailed') }}
    </div>
    <div
      v-else-if="!overview || !users || !revenue"
      class="text-sm text-muted"
    >
      {{ t('adminStats.loading') }}
    </div>
    <div
      v-else
      class="space-y-5"
    >
      <section>
        <h2 class="text-sm text-muted mb-2">
          {{ t('adminStats.investor.users') }}
        </h2>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <AdminStatsKpi
            :label="t('adminStats.kpi.registered')"
            :value="n(users.registered)"
          />
          <AdminStatsKpi
            :label="t('adminStats.kpi.mau')"
            :value="n(users.active.month)"
          />
          <AdminStatsKpi
            :label="t('adminStats.kpi.dau')"
            :value="n(users.active.day)"
            :hint="`${t('adminStats.kpi.stickiness')}: ${statsPercent(users.active.stickinessPct, locale)}`"
          />
          <AdminStatsKpi
            :label="t('adminStats.kpi.signups')"
            :value="n(users.signups.value)"
            :kpi="users.signups"
          />
        </div>
      </section>
      <section>
        <h2 class="text-sm text-muted mb-2">
          {{ t('adminStats.investor.revenue') }}
        </h2>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <AdminStatsKpi
            :label="t('adminStats.kpi.mrrTotal')"
            :value="statsMoney(revenue.combinedChf.mrr, 'chf', locale)"
            :hint="`${t('adminStats.kpi.arrTotal')}: ${statsMoney(revenue.combinedChf.arr, 'chf', locale)}`"
          />
          <AdminStatsKpi
            :label="t('adminStats.kpi.contribution')"
            :value="statsMoney(revenue.estimate.combinedChf.contribution, 'chf', locale)"
            :hint="t('adminStats.estimate.estimated')"
          />
          <AdminStatsKpi
            v-for="r in revenue.revenue"
            :key="r.currency"
            :label="t('adminStats.kpi.mrr', { currency: r.currency.toUpperCase() })"
            :value="statsMoney(r.mrr, r.currency, locale)"
            :hint="t('adminStats.kpi.arr', { currency: r.currency.toUpperCase() }) + ': ' + statsMoney(r.arr, r.currency, locale)"
          />
          <AdminStatsKpi
            :label="t('adminStats.kpi.payingCustomers')"
            :value="n(revenue.payingCustomers)"
            :hint="revenue.billingEnabled ? null : t('adminStats.hint.billingOff')"
          />
          <AdminStatsKpi
            :label="t('adminStats.kpi.waitlistConfirmed')"
            :value="n(revenue.waitlist.confirmed)"
          />
        </div>
      </section>
      <section>
        <h2 class="text-sm text-muted mb-2">
          {{ t('adminStats.investor.content') }} · {{ t('adminStats.investor.ai') }}
        </h2>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <AdminStatsKpi
            :label="t('adminStats.kpi.documents')"
            :value="n(overview.content.documents)"
          />
          <AdminStatsKpi
            :label="t('adminStats.kpi.workspaces')"
            :value="n(overview.content.workspaces)"
          />
          <AdminStatsKpi
            :label="t('adminStats.kpi.aiUsers')"
            :value="n(overview.ai.aiUsers.value)"
          />
          <AdminStatsKpi
            :label="t('adminStats.kpi.aiSpend')"
            :value="usd(overview.ai.spendUsd.value)"
          />
        </div>
      </section>
      <ClientOnly>
        <div class="grid gap-3 sm:grid-cols-2">
          <AdminStatsChart
            type="line"
            :title="t('adminStats.chart.accounts')"
            :labels="months(users.signupSeries)"
            :datasets="[{ label: t('adminStats.chart.accounts'), data: cumulativeSeries(users.signupSeries, users.registered).map(p => p.v) }]"
            :format-value="n"
            :height="190"
          />
          <AdminStatsChart
            type="bar"
            :title="t('adminStats.chart.signups')"
            :labels="months(users.signupSeries)"
            :datasets="[{ label: t('adminStats.chart.signups'), data: users.signupSeries.map(p => p.v) }]"
            :format-value="n"
            :height="190"
          />
          <AdminStatsChart
            type="line"
            :title="t('adminStats.chart.editors')"
            :labels="months(users.editorSeries)"
            :datasets="[{ label: t('adminStats.chart.editors'), data: users.editorSeries.map(p => p.v) }]"
            :format-value="n"
            :height="190"
          />
          <AdminStatsChart
            type="bar"
            :title="t('adminStats.chart.documents')"
            :labels="months(overview.content.documentSeries)"
            :datasets="[{ label: t('adminStats.chart.documents'), data: overview.content.documentSeries.map(p => p.v) }]"
            :format-value="n"
            :height="190"
          />
        </div>
      </ClientOnly>
      <p class="text-xs text-muted">
        {{ t('adminStats.investor.footnote') }}
      </p>
    </div>
  </div>
</template>
