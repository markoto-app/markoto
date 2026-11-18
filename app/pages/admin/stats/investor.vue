<script setup lang="ts">
import type { OverviewStats, RevenueStats, UsersStats } from '~~/shared/contracts/adminStats'
import { useAdminStatsQuery } from '~/queries/adminStats'

// One-page investor summary: the key numbers and 12 months of monthly
// charts, in the same tiles and chart cards as the stats page. Printed
// (the browser's "Save as PDF") it is an A4 document: the admin chrome
// and the buttons are left out, the key numbers fill page one and the
// growth charts page two.

definePageMeta({ layout: 'admin' })

const { t, locale } = useI18n()
const { isAdmin } = useAdminGate()

useHead({ title: () => `${t('adminStats.investorTitle')} · ${t('admin.title')}` })

const overviewQuery = useAdminStatsQuery('overview', '365', isAdmin, 'month')
const usersQuery = useAdminStatsQuery('users', '365', isAdmin, 'month')
const revenueQuery = useAdminStatsQuery('revenue', '30', isAdmin)

const overview = computed(() => overviewQuery.data.value as OverviewStats | undefined)
const users = computed(() => usersQuery.data.value as UsersStats | undefined)
const revenue = computed(() => revenueQuery.data.value as RevenueStats | undefined)
const failed = computed(() => Boolean(overviewQuery.error.value || usersQuery.error.value || revenueQuery.error.value))

const n = (v: number) => statsCount(v, locale.value)
const usd = (v: number) => statsMoney(v, 'usd', locale.value)
const chf = (v: number) => statsMoney(v, 'chf', locale.value)
const today = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'long' }).format(new Date()))
const months = (pts: Array<{ t: string }>) => pts.map(p => statsBucketLabel(p.t, 'month', locale.value))
const subtitle = computed(() => t('adminStats.investor.subtitle', { date: today.value }))

function print(): void {
  globalThis.print()
}
</script>

<template>
  <div
    class="investor-summary"
    data-testid="admin-stats-investor"
  >
    <AdminPageHeader
      :title="t('adminStats.investorTitle')"
      :intro="subtitle"
    >
      <template #actions>
        <UButton
          to="/admin/stats"
          size="sm"
          variant="ghost"
          icon="i-lucide-arrow-left"
        >
          {{ t('adminStats.back') }}
        </UButton>
        <UButton
          size="sm"
          icon="i-lucide-printer"
          data-testid="admin-stats-print"
          @click="print"
        >
          {{ t('adminStats.print') }}
        </UButton>
      </template>
    </AdminPageHeader>

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
      class="space-y-8 print:space-y-5"
    >
      <AdminSection :title="t('adminStats.investor.users')">
        <AdminStatsKpiGrid>
          <AdminStatsKpi
            :label="t('adminStats.kpi.registered')"
            :value="n(users.registered)"
          />
          <AdminStatsKpi
            :label="t('adminStats.kpi.signups')"
            :value="n(users.signups.value)"
            :kpi="users.signups"
            :hint="t('adminStats.investor.last12Months')"
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
        </AdminStatsKpiGrid>
      </AdminSection>

      <AdminSection
        :title="t('adminStats.investor.revenue')"
        :note="revenue.billingEnabled ? t('adminStats.hint.listPrice') : `${t('adminStats.hint.billingOff')} ${t('adminStats.hint.listPrice')}`"
      >
        <AdminStatsKpiGrid>
          <AdminStatsKpi
            :label="t('adminStats.kpi.mrrTotal')"
            :value="chf(revenue.combinedChf.mrr)"
            :hint="`${t('adminStats.kpi.arrTotal')}: ${chf(revenue.combinedChf.arr)}`"
          />
          <AdminStatsKpi
            :label="t('adminStats.kpi.contribution')"
            :value="chf(revenue.estimate.combinedChf.contribution)"
            :hint="t('adminStats.estimate.estimated')"
          />
          <AdminStatsKpi
            :label="t('adminStats.kpi.payingCustomers')"
            :value="n(revenue.payingCustomers)"
            :hint="revenue.revenue.map(r => `${t('adminStats.kpi.mrr', { currency: r.currency.toUpperCase() })}: ${statsMoney(r.mrr, r.currency, locale)}`).join(' · ') || null"
          />
          <AdminStatsKpi
            :label="t('adminStats.kpi.waitlistConfirmed')"
            :value="n(revenue.waitlist.confirmed)"
          />
        </AdminStatsKpiGrid>
      </AdminSection>

      <AdminSection :title="`${t('adminStats.investor.content')} · ${t('adminStats.investor.ai')}`">
        <AdminStatsKpiGrid>
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
            :hint="t('adminStats.investor.last12Months')"
          />
        </AdminStatsKpiGrid>
      </AdminSection>

      <AdminSection
        :title="t('adminStats.investor.growth')"
        page-break
      >
        <AdminStatsChartGrid>
          <AdminStatsChart
            type="line"
            :title="t('adminStats.chart.accounts')"
            :labels="months(users.signupSeries)"
            :datasets="[{ label: t('adminStats.chart.accounts'), data: cumulativeSeries(users.signupSeries, users.registered).map(p => p.v) }]"
            :format-value="n"
            :height="200"
          />
          <AdminStatsChart
            type="bar"
            :title="t('adminStats.chart.signups')"
            :labels="months(users.signupSeries)"
            :datasets="[{ label: t('adminStats.chart.signups'), data: users.signupSeries.map(p => p.v) }]"
            :format-value="n"
            :height="200"
          />
          <AdminStatsChart
            type="line"
            :title="t('adminStats.chart.editors')"
            :labels="months(users.editorSeries)"
            :datasets="[{ label: t('adminStats.chart.editors'), data: users.editorSeries.map(p => p.v) }]"
            :format-value="n"
            :height="200"
          />
          <AdminStatsChart
            type="bar"
            :title="t('adminStats.chart.documents')"
            :labels="months(overview.content.documentSeries)"
            :datasets="[{ label: t('adminStats.chart.documents'), data: overview.content.documentSeries.map(p => p.v) }]"
            :format-value="n"
            :height="200"
          />
        </AdminStatsChartGrid>
      </AdminSection>

      <p class="text-xs text-muted border-t border-default pt-3">
        {{ t('adminStats.investor.footnote') }}
      </p>
    </div>
  </div>
</template>

<style>
@media print {
  @page {
    size: A4;
    margin: 14mm 12mm;
  }

  /* The canvases keep their on-screen bitmap; scale it to the print column. */
  .investor-summary canvas {
    width: 100% !important;
    height: auto !important;
  }
}
</style>
