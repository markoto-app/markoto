<script setup lang="ts">
import { pct, type UsersStats } from '~~/shared/contracts/adminStats'

const props = defineProps<{ data: UsersStats, range: string }>()
const { t, locale } = useI18n()
const n = (v: number) => statsCount(v, locale.value)
const bucketLabels = computed(() => props.data.signupSeries.map(p => statsBucketLabel(p.t, props.data.window.bucket, locale.value)))

const growthColumns = computed(() => [
  { key: 'period', label: t('adminStats.table.period') },
  { key: 'signups', label: t('adminStats.chart.signups'), numeric: true },
  { key: 'editors', label: t('adminStats.chart.editors'), numeric: true }
])
const growthCsv = computed(() => props.data.signupSeries.map((p, i) => ({ period: p.t, signups: p.v, editors: props.data.editorSeries[i]?.v ?? 0 })))
const growthRows = computed(() => growthCsv.value.map(r => ({ period: statsBucketLabel(r.period, props.data.window.bucket, locale.value), signups: n(r.signups), editors: n(r.editors) })))

const activationSteps = computed(() => {
  const a = props.data.activation
  return [
    { key: 'signedUp', v: a.cohort },
    { key: 'createdDoc', v: a.createdDoc },
    { key: 'edited', v: a.edited },
    { key: 'usedAi', v: a.usedAi }
  ]
})
const activationColumns = computed(() => [
  { key: 'step', label: t('adminStats.table.metric') },
  { key: 'count', label: t('adminStats.table.count'), numeric: true },
  { key: 'share', label: t('adminStats.table.share'), numeric: true }
])
const activationCsv = computed(() => activationSteps.value.map(s => ({ step: t(`adminStats.activation.${s.key}`), count: s.v, share: pct(s.v, props.data.activation.cohort) })))
const activationRows = computed(() => activationCsv.value.map(r => ({ step: r.step, count: n(r.count), share: statsPercent(r.share, locale.value) })))

const providerColumns = computed(() => [
  { key: 'provider', label: t('adminStats.table.provider') },
  { key: 'accounts', label: t('adminStats.table.accounts'), numeric: true }
])
const providerCsv = computed(() => (['github', 'google', 'oidc', 'sso'] as const).map(p => ({ provider: t(`adminStats.provider.${p}`), accounts: props.data.providers[p] })))
const providerRows = computed(() => providerCsv.value.map(r => ({ provider: r.provider, accounts: n(r.accounts) })))

const planColumns = computed(() => [
  { key: 'plan', label: t('adminStats.table.plan') },
  { key: 'accounts', label: t('adminStats.table.accounts'), numeric: true }
])
const planCsv = computed(() => (['free', 'pro'] as const).map(p => ({ plan: t(`adminStats.plan.${p}`), accounts: props.data.plans[p] })))
const planRows = computed(() => planCsv.value.map(r => ({ plan: r.plan, accounts: n(r.accounts) })))
</script>

<template>
  <div class="space-y-6">
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <AdminStatsKpi
        :label="t('adminStats.kpi.registered')"
        :value="n(data.registered)"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.signups')"
        :value="n(data.signups.value)"
        :kpi="data.signups"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.editors')"
        :value="n(data.editors.value)"
        :kpi="data.editors"
        :hint="t('adminStats.hint.editorsDefinition')"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.activeInWindow')"
        :value="n(data.active.inWindow)"
        :hint="t('adminStats.hint.activeDefinition')"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.dau')"
        :value="n(data.active.day)"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.wau')"
        :value="n(data.active.week)"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.mau')"
        :value="n(data.active.month)"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.stickiness')"
        :value="statsPercent(data.active.stickinessPct, locale)"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.pendingDeletion')"
        :value="n(data.pendingDeletion)"
      />
    </div>
    <ClientOnly>
      <div class="grid gap-3 lg:grid-cols-2">
        <AdminStatsChart
          type="bar"
          :title="t('adminStats.chart.signups')"
          :labels="bucketLabels"
          :datasets="[{ label: t('adminStats.chart.signups'), data: data.signupSeries.map(p => p.v) }]"
          :format-value="n"
        />
        <AdminStatsChart
          type="line"
          :title="t('adminStats.chart.editors')"
          :labels="bucketLabels"
          :datasets="[{ label: t('adminStats.chart.editors'), data: data.editorSeries.map(p => p.v) }]"
          :format-value="n"
        />
        <AdminStatsChart
          type="bar"
          horizontal
          :title="t('adminStats.chart.activation')"
          :labels="activationSteps.map(s => t(`adminStats.activation.${s.key}`))"
          :datasets="[{ label: t('adminStats.table.accounts'), data: activationSteps.map(s => s.v) }]"
          :format-value="n"
          :height="180"
        />
      </div>
    </ClientOnly>
    <AdminStatsCohorts
      :cohorts="data.cohorts"
      :range="range"
    />
    <div class="grid gap-3 lg:grid-cols-2">
      <AdminStatsTable
        :title="t('adminStats.section.growth')"
        name="growth"
        :range="range"
        :columns="growthColumns"
        :rows="growthRows"
        :csv-rows="growthCsv"
      />
      <div class="space-y-3">
        <AdminStatsTable
          :title="t('adminStats.section.activation')"
          name="activation"
          :range="range"
          :columns="activationColumns"
          :rows="activationRows"
          :csv-rows="activationCsv"
        />
        <AdminStatsTable
          :title="t('adminStats.section.providers')"
          name="providers"
          :range="range"
          :columns="providerColumns"
          :rows="providerRows"
          :csv-rows="providerCsv"
        />
        <AdminStatsTable
          :title="t('adminStats.section.plans')"
          name="plans"
          :range="range"
          :columns="planColumns"
          :rows="planRows"
          :csv-rows="planCsv"
        />
      </div>
    </div>
  </div>
</template>
