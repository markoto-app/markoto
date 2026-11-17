<script setup lang="ts">
import type { RevenueStats } from '~~/shared/contracts/adminStats'

const props = defineProps<{ data: RevenueStats, range: string }>()
const { t, locale } = useI18n()
const n = (v: number) => statsCount(v, locale.value)
const money = (v: number, c: string) => statsMoney(v, c, locale.value)

const notes = computed(() => {
  const out = [t('adminStats.hint.listPrice')]
  if (!props.data.billingEnabled) out.unshift(t('adminStats.hint.billingOff'))
  if (props.data.plansComingSoon) out.push(t('adminStats.hint.comingSoon'))
  if (props.data.priceSource === 'planned' && props.data.groups.length > 0) out.push(t('adminStats.hint.plannedPrices'))
  return out
})

const groupColumns = computed(() => [
  { key: 'plan', label: t('adminStats.table.plan') },
  { key: 'currency', label: t('adminStats.table.currency') },
  { key: 'interval', label: t('adminStats.table.interval') },
  { key: 'subscriptions', label: t('adminStats.table.subscriptions'), numeric: true },
  { key: 'units', label: t('adminStats.table.units'), numeric: true }
])
const groupCsv = computed(() => props.data.groups.map(g => ({
  plan: t(`adminStats.plan.${g.plan}`),
  currency: g.currency.toUpperCase(),
  interval: t(`adminStats.interval.${g.interval}`),
  subscriptions: g.subscriptions,
  units: g.units
})))
const groupRows = computed(() => groupCsv.value.map(r => ({ ...r, subscriptions: n(r.subscriptions), units: n(r.units) })))

const mixColumns = computed(() => [
  { key: 'plan', label: t('adminStats.table.plan') },
  { key: 'count', label: t('adminStats.table.count'), numeric: true }
])
const mixCsv = computed(() => (['free', 'pro', 'team', 'business'] as const).map(p => ({ plan: t(`adminStats.plan.${p}`), count: props.data.planMix[p] })))
const mixRows = computed(() => mixCsv.value.map(r => ({ plan: r.plan, count: n(r.count) })))

const topupColumns = computed(() => [
  { key: 'currency', label: t('adminStats.table.currency') },
  { key: 'amount', label: t('adminStats.table.amount'), numeric: true },
  { key: 'purchases', label: t('adminStats.table.purchases'), numeric: true }
])
const topupCsv = computed(() => props.data.topups.map(r => ({ currency: r.currency.toUpperCase(), amount: r.amount, purchases: r.count })))
function moneyList(list: RevenueStats['revenue'], key: string): string | null {
  return list.map(r => `${t(key, { currency: r.currency.toUpperCase() })}: ${money(r.mrr, r.currency)}`).join(' · ') || null
}

// Estimated monthly contribution: one column per currency, then all in CHF.
const estimateColumns = computed(() => [
  { key: 'line', label: t('adminStats.table.metric') },
  ...props.data.estimate.perCurrency.map(c => ({ key: c.currency, label: c.currency.toUpperCase(), numeric: true })),
  { key: 'chf', label: t('adminStats.estimate.combined'), numeric: true }
])
const estimateLines = computed(() => {
  const a = props.data.estimate.assumptions
  const lines: Array<{ key: 'gross' | 'tax' | 'fees' | 'net' | 'aiCost' | 'contribution', label: string }> = [
    { key: 'gross', label: t('adminStats.estimate.gross') },
    { key: 'tax', label: t('adminStats.estimate.tax', { pct: a.taxPct }) },
    { key: 'fees', label: t('adminStats.estimate.fees', { pct: a.paymentFeePct, fixed: a.paymentFeeFixed }) },
    { key: 'net', label: t('adminStats.estimate.net') },
    { key: 'aiCost', label: t('adminStats.estimate.aiCost') },
    { key: 'contribution', label: t('adminStats.estimate.contribution') }
  ]
  return lines
})
const estimateCsv = computed(() => estimateLines.value.map(line => ({
  line: line.label,
  ...Object.fromEntries(props.data.estimate.perCurrency.map(c => [c.currency, line.key === 'aiCost' || line.key === 'contribution' ? null : c[line.key]])),
  chf: props.data.estimate.combinedChf[line.key]
})))
const estimateRows = computed(() => estimateLines.value.map(line => ({
  line: line.label,
  ...Object.fromEntries(props.data.estimate.perCurrency.map(c => [c.currency, line.key === 'aiCost' || line.key === 'contribution' ? '' : money(c[line.key], c.currency)])),
  chf: money(props.data.estimate.combinedChf[line.key], 'chf')
})))
const estimateNote = computed(() => {
  const a = props.data.estimate.assumptions
  const note = t('adminStats.estimate.note', { eur: a.eurChfRate, usd: a.usdChfRate })
  return props.data.estimate.aiCostUsd === null ? `${note} ${t('adminStats.estimate.aiUnavailable')}` : note
})

const topupRows = computed(() => props.data.topups.map(r => ({ currency: r.currency.toUpperCase(), amount: money(r.amount, r.currency), purchases: n(r.count) })))
</script>

<template>
  <div class="space-y-6">
    <ul class="text-sm text-muted space-y-1">
      <li
        v-for="note in notes"
        :key="note"
      >
        {{ note }}
      </li>
    </ul>
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <AdminStatsKpi
        :label="t('adminStats.kpi.mrrTotal')"
        :value="money(data.combinedChf.mrr, 'chf')"
        :hint="`${t('adminStats.kpi.arrTotal')}: ${money(data.combinedChf.arr, 'chf')}`"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.contribution')"
        :value="money(data.estimate.combinedChf.contribution, 'chf')"
        :hint="t('adminStats.estimate.estimated')"
      />
      <template
        v-for="r in data.revenue"
        :key="r.currency"
      >
        <AdminStatsKpi
          :label="t('adminStats.kpi.mrr', { currency: r.currency.toUpperCase() })"
          :value="money(r.mrr, r.currency)"
        />
        <AdminStatsKpi
          :label="t('adminStats.kpi.arr', { currency: r.currency.toUpperCase() })"
          :value="money(r.arr, r.currency)"
        />
      </template>
      <AdminStatsKpi
        :label="t('adminStats.kpi.payingCustomers')"
        :value="n(data.payingCustomers)"
        :hint="data.revenue.length === 0 ? t('adminStats.hint.noRevenue') : null"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.trialing')"
        :value="n(data.trialing)"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.pastDue')"
        :value="n(data.pastDue)"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.scheduledCancellations')"
        :value="n(data.scheduledCancellations.subscriptions)"
        :hint="data.scheduledCancellations.revenue.map(r => t('adminStats.kpi.atRisk', { currency: r.currency.toUpperCase() }) + ': ' + money(r.mrr, r.currency)).join(' · ') || null"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.subsStarted')"
        :value="n(data.churn.started.value)"
        :kpi="data.churn.started"
        :hint="moneyList(data.churn.newMrr, 'adminStats.kpi.newMrr')"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.cancelScheduled')"
        :value="n(data.churn.cancelScheduled.value)"
        :kpi="data.churn.cancelScheduled"
        lower-is-better
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.subsEnded')"
        :value="n(data.churn.ended.value)"
        :kpi="data.churn.ended"
        :hint="moneyList(data.churn.lostMrr, 'adminStats.kpi.lostMrr')"
        lower-is-better
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.waitlistConfirmed')"
        :value="n(data.waitlist.confirmed)"
        :hint="`${t('adminStats.kpi.waitlistUnconfirmed')}: ${n(data.waitlist.unconfirmed)}`"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.waitlistNew')"
        :value="n(data.waitlist.newConfirmed.value)"
        :kpi="data.waitlist.newConfirmed"
      />
    </div>
    <p class="text-xs text-muted">
      {{ t('adminStats.hint.churnHistory') }}
    </p>
    <ClientOnly>
      <AdminStatsChart
        type="bar"
        :title="t('adminStats.chart.subscriptions')"
        :labels="data.churn.startedSeries.map(p => statsBucketLabel(p.t, data.window.bucket, locale))"
        :datasets="[
          { label: t('adminStats.chart.started'), data: data.churn.startedSeries.map(p => p.v) },
          { label: t('adminStats.chart.ended'), data: data.churn.endedSeries.map(p => p.v) }
        ]"
        :format-value="n"
      />
    </ClientOnly>
    <AdminStatsTable
      :title="t('adminStats.section.estimate')"
      name="estimated-contribution"
      :range="range"
      :columns="estimateColumns"
      :rows="estimateRows"
      :csv-rows="estimateCsv"
    />
    <p class="text-xs text-muted">
      {{ estimateNote }}
    </p>
    <div class="grid gap-3 lg:grid-cols-2">
      <AdminStatsTable
        :title="t('adminStats.section.subscriptions')"
        name="subscriptions"
        :range="range"
        :columns="groupColumns"
        :rows="groupRows"
        :csv-rows="groupCsv"
      />
      <AdminStatsTable
        :title="t('adminStats.section.planMix')"
        name="plan-mix"
        :range="range"
        :columns="mixColumns"
        :rows="mixRows"
        :csv-rows="mixCsv"
      />
      <AdminStatsTable
        :title="t('adminStats.section.topups')"
        name="ai-credits"
        :range="range"
        :columns="topupColumns"
        :rows="topupRows"
        :csv-rows="topupCsv"
      />
    </div>
  </div>
</template>
