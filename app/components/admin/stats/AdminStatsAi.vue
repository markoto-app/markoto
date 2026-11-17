<script setup lang="ts">
import type { AiStats } from '~~/shared/contracts/adminStats'

const props = defineProps<{ data: AiStats, range: string }>()
const { t, te, locale } = useI18n()
const n = (v: number) => statsCount(v, locale.value)
const usd = (v: number) => statsMoney(v, 'usd', locale.value)

function featureLabel(tag: string): string {
  const key = `adminStats.feature.${tag.replace(/^feature:/, '')}`
  return te(key) ? t(key) : tag
}

const pivot = computed(() => pivotStatsSeries(props.data.series.map(s => ({ t: s.t, key: s.feature, v: s.spendUsd }))))
const chartLabels = computed(() => pivot.value.buckets.map(b => statsBucketLabel(b, props.data.window.bucket, locale.value)))
const chartDatasets = computed(() => pivot.value.datasets.map(d => ({ label: featureLabel(d.key), data: d.data })))

const featureColumns = computed(() => [
  { key: 'feature', label: t('adminStats.table.feature') },
  { key: 'cost', label: t('adminStats.table.cost'), numeric: true },
  { key: 'requests', label: t('adminStats.table.requests'), numeric: true }
])
const featureCsv = computed(() => props.data.byFeature.map(f => ({ feature: featureLabel(f.feature), cost: f.spendUsd, requests: f.requests })))
const featureRows = computed(() => featureCsv.value.map(r => ({ feature: r.feature, cost: usd(r.cost), requests: n(r.requests) })))

const spendNote = computed(() => {
  if (!props.data.spendAvailable) return t('adminStats.hint.spendUnavailable')
  return props.data.spendFrom > props.data.window.from ? t('adminStats.hint.spendFrom', { day: props.data.spendFrom }) : null
})
const pool = computed(() => props.data.freePool)
</script>

<template>
  <div class="space-y-6">
    <p
      v-if="spendNote"
      class="text-sm text-muted"
    >
      {{ spendNote }}
    </p>
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <AdminStatsKpi
        :label="t('adminStats.kpi.aiSpend')"
        :value="usd(data.spendUsd.value)"
        :kpi="data.spendUsd"
        lower-is-better
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.aiRequests')"
        :value="n(data.requests.value)"
        :kpi="data.requests"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.aiUsers')"
        :value="n(data.aiUsers.value)"
        :kpi="data.aiUsers"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.costPerAiUser')"
        :value="usd(data.costPerAiUserUsd)"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.costPerActiveUser')"
        :value="usd(data.costPerActiveUserUsd)"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.freePool')"
        :value="pool.capUsd === null ? usd(pool.spentThisMonthUsd) : statsPercent(pool.pct, locale)"
        :hint="pool.capUsd === null ? t('adminStats.hint.freePoolOff') : t('adminStats.hint.freePool', { spent: usd(pool.spentThisMonthUsd), cap: usd(pool.capUsd) })"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.byokUsers')"
        :value="n(data.byok.users)"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.mcpSessions')"
        :value="n(data.mcp.sessions.value)"
        :kpi="data.mcp.sessions"
        :hint="`${t('adminStats.kpi.mcpTokens')}: ${n(data.mcp.activeTokens)}`"
      />
    </div>
    <ClientOnly>
      <AdminStatsChart
        v-if="chartDatasets.length > 0"
        type="bar"
        stacked
        :title="t('adminStats.chart.aiSpend')"
        :labels="chartLabels"
        :datasets="chartDatasets"
        :format-value="usd"
        :height="280"
      />
    </ClientOnly>
    <AdminStatsTable
      :title="t('adminStats.section.aiSpend')"
      name="ai-cost"
      :range="range"
      :columns="featureColumns"
      :rows="featureRows"
      :csv-rows="featureCsv"
    />
  </div>
</template>
