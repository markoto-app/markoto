<script setup lang="ts">
import type { OverviewStats } from '~~/shared/contracts/adminStats'

const props = defineProps<{ data: OverviewStats }>()
const { t, locale } = useI18n()
const n = (v: number) => statsCount(v, locale.value)
const labels = (pts: Array<{ t: string }>) => pts.map(p => statsBucketLabel(p.t, props.data.window.bucket, locale.value))
const usd = (v: number) => statsMoney(v, 'usd', locale.value)
</script>

<template>
  <div class="space-y-6">
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <AdminStatsKpi
        :label="t('adminStats.kpi.registered')"
        :value="n(data.users.registered)"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.signups')"
        :value="n(data.users.signups.value)"
        :kpi="data.users.signups"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.mau')"
        :value="n(data.users.active.month)"
        :hint="t('adminStats.kpi.dau') + ': ' + n(data.users.active.day)"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.editors')"
        :value="n(data.users.editors.value)"
        :kpi="data.users.editors"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.documents')"
        :value="n(data.content.documents)"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.documentsCreated')"
        :value="n(data.content.created.value)"
        :kpi="data.content.created"
      />
      <AdminStatsKpi
        v-for="r in data.revenue.revenue"
        :key="r.currency"
        :label="t('adminStats.kpi.mrr', { currency: r.currency.toUpperCase() })"
        :value="statsMoney(r.mrr, r.currency, locale)"
        :hint="t('adminStats.kpi.arr', { currency: r.currency.toUpperCase() }) + ': ' + statsMoney(r.arr, r.currency, locale)"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.payingCustomers')"
        :value="n(data.revenue.payingCustomers)"
        :hint="data.revenue.revenue.length === 0 ? t('adminStats.hint.noRevenue') : null"
      />
      <AdminStatsKpi
        v-if="data.revenue.plansComingSoon || data.revenue.waitlistConfirmed > 0"
        :label="t('adminStats.kpi.waitlistConfirmed')"
        :value="n(data.revenue.waitlistConfirmed)"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.aiSpend')"
        :value="usd(data.ai.spendUsd.value)"
        :kpi="data.ai.spendUsd"
        :hint="data.ai.spendAvailable ? null : t('adminStats.hint.spendUnavailable')"
        lower-is-better
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.workspaces')"
        :value="n(data.content.workspaces)"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.knowledgeFiles')"
        :value="n(data.content.knowledgeFiles)"
      />
    </div>
    <ClientOnly>
      <div class="grid gap-3 lg:grid-cols-2">
        <AdminStatsChart
          type="bar"
          :title="t('adminStats.chart.signups')"
          :labels="labels(data.users.signupSeries)"
          :datasets="[{ label: t('adminStats.chart.signups'), data: data.users.signupSeries.map(p => p.v) }]"
          :format-value="n"
        />
        <AdminStatsChart
          type="line"
          :title="t('adminStats.chart.editors')"
          :labels="labels(data.users.editorSeries)"
          :datasets="[{ label: t('adminStats.chart.editors'), data: data.users.editorSeries.map(p => p.v) }]"
          :format-value="n"
        />
        <AdminStatsChart
          type="bar"
          :title="t('adminStats.chart.documents')"
          :labels="labels(data.content.documentSeries)"
          :datasets="[{ label: t('adminStats.chart.documents'), data: data.content.documentSeries.map(p => p.v) }]"
          :format-value="n"
        />
      </div>
    </ClientOnly>
  </div>
</template>
