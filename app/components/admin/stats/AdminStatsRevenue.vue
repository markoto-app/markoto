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
        :label="t('adminStats.kpi.endedWorkspacePlans')"
        :value="n(data.endedWorkspaceSubscriptions.value)"
        :kpi="data.endedWorkspaceSubscriptions"
        :hint="t('adminStats.hint.personalChurn')"
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
