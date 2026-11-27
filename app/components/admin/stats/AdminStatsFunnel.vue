<script setup lang="ts">
import { FUNNEL_STEPS, stepConversion, stepExceedsPrevious, type FunnelRow, type FunnelStats } from '~~/shared/contracts/adminStats'

// Funnel by source: per acquisition source (Product Hunt, Hacker News, …)
// the visits, first documents, sign-ups, checkouts and paying accounts of
// the range, with the step-to-step conversion. Definitions:
// docs/contributing/admin-metrics.md#funnel-by-source.

const props = defineProps<{ data: FunnelStats, range: string }>()
const { t, locale } = useI18n()
const n = (v: number) => statsCount(v, locale.value)

const columns = computed(() => [
  { key: 'source', label: t('adminStats.funnel.source') },
  ...FUNNEL_STEPS.map(step => ({ key: step, label: t(`adminStats.funnel.step.${step}`), numeric: true }))
])

function sourceLabel(row: FunnelRow): string {
  return t(`adminStats.funnel.sources.${row.source}`)
}

/**
 * "12 · 34 %": the count and its conversion from the step before. A step
 * larger than the one before shows its count only (see `stepExceedsPrevious`).
 */
function cell(row: FunnelRow, step: typeof FUNNEL_STEPS[number]): string {
  const value = row[step]
  if (value === null) return t('adminStats.funnel.unavailable')
  const conversion = stepConversion(row, step)
  return conversion === null ? n(value) : `${n(value)} · ${statsPercent(conversion, locale.value)}`
}

const allRows = computed(() => [...props.data.rows, props.data.total])

/** Some step outgrows the one before it: explain why it carries no share. */
const exceedsPrevious = computed(() => allRows.value.some(r => FUNNEL_STEPS.some(s => stepExceedsPrevious(r, s))))

const table = computed(() => ({
  rows: allRows.value.map(r => ({ source: sourceLabel(r), ...Object.fromEntries(FUNNEL_STEPS.map(s => [s, cell(r, s)])) })),
  csv: allRows.value.map(r => ({ source: r.source, ...Object.fromEntries(FUNNEL_STEPS.map(s => [s, r[s]])) }))
}))
</script>

<template>
  <div
    class="space-y-8"
    data-testid="admin-stats-funnel"
  >
    <AdminSection
      :title="t('adminStats.funnel.totals')"
      :note="t('adminStats.funnel.note')"
    >
      <p
        v-if="!data.trackingEnabled"
        class="text-sm text-muted"
        data-testid="admin-stats-funnel-off"
      >
        {{ t('adminStats.funnel.notTracking') }}
      </p>
      <p
        v-if="exceedsPrevious"
        class="text-sm text-muted"
        data-testid="admin-stats-funnel-exceeds"
      >
        {{ t('adminStats.funnel.exceedsPrevious') }}
      </p>
      <AdminStatsKpiGrid>
        <AdminStatsKpi
          v-for="step in FUNNEL_STEPS"
          :key="step"
          :label="t(`adminStats.funnel.step.${step}`)"
          :value="cell(data.total, step)"
        />
      </AdminStatsKpiGrid>
    </AdminSection>
    <AdminSection :title="t('adminStats.funnel.bySource')">
      <p
        v-if="!data.visitsAvailable"
        class="text-sm text-muted"
        data-testid="admin-stats-funnel-no-visits"
      >
        {{ t('adminStats.funnel.noVisits') }}
      </p>
      <AdminStatsTable
        :title="t('adminStats.funnel.bySource')"
        name="funnel-by-source"
        :range="range"
        :columns="columns"
        :rows="table.rows"
        :csv-rows="table.csv"
      />
    </AdminSection>
  </div>
</template>
