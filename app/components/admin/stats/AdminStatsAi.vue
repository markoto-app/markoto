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
  const notes: string[] = []
  if (props.data.spendFrom > props.data.window.from) notes.push(t('adminStats.hint.spendFrom', { day: props.data.spendFrom }))
  if (props.data.aiUsersFrom > props.data.window.from) notes.push(t('adminStats.hint.aiUsersFrom', { day: props.data.aiUsersFrom }))
  return notes.join(' ') || null
})
const pool = computed(() => props.data.freePool)
</script>

<template>
  <div class="space-y-8">
    <AdminSection
      :title="t('adminStats.section.aiUsage')"
      :note="spendNote"
    >
      <AdminStatsKpiGrid>
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
          :hint="t('adminStats.hint.aiUsersDefinition')"
        />
        <AdminStatsKpi
          :label="t('adminStats.kpi.costPerAiUser')"
          :value="usd(data.costPerAiUserUsd)"
          :hint="`${t('adminStats.kpi.costPerActiveUser')}: ${usd(data.costPerActiveUserUsd)}`"
        />
      </AdminStatsKpiGrid>
    </AdminSection>
    <AdminSection :title="t('adminStats.section.aiAccess')">
      <AdminStatsKpiGrid>
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
        />
        <AdminStatsKpi
          :label="t('adminStats.kpi.mcpTokens')"
          :value="n(data.mcp.activeTokens)"
        />
      </AdminStatsKpiGrid>
    </AdminSection>
    <AdminSection
      v-if="chartDatasets.length > 0"
      :title="t('adminStats.section.trends')"
    >
      <ClientOnly>
        <AdminStatsChart
          type="bar"
          stacked
          kind="money"
          :title="t('adminStats.chart.aiSpend')"
          :labels="chartLabels"
          :datasets="chartDatasets"
          :format-value="usd"
          :height="280"
        />
      </ClientOnly>
    </AdminSection>
    <AdminSection :title="t('adminStats.section.details')">
      <AdminStatsTable
        :title="t('adminStats.section.aiSpend')"
        name="ai-cost"
        :range="range"
        :columns="featureColumns"
        :rows="featureRows"
        :csv-rows="featureCsv"
      />
    </AdminSection>
  </div>
</template>
