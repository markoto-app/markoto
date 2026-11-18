<script setup lang="ts">
import type { UsersStats } from '~~/shared/contracts/adminStats'

// Retention heatmap: one row per weekly sign-up cohort, one cell per week
// after sign-up, shaded by the share that edited. A table, so screen
// readers and the CSV get the same numbers.
const props = defineProps<{
  cohorts: UsersStats['cohorts']
  range: string
}>()

const { t, locale } = useI18n()
const weeks = computed(() => Math.max(0, ...props.cohorts.map(c => c.retention.length)))

function cellStyle(pct: number | null): Record<string, string> {
  const alpha = retentionAlpha(pct)
  return {
    backgroundColor: `color-mix(in srgb, var(--color-shu-500) ${Math.round(alpha * 100)}%, transparent)`,
    color: alpha > 0.55 ? 'var(--color-sumi-50)' : 'var(--ui-text)'
  }
}

const csvColumns = computed(() => [
  { key: 'week', label: t('adminStats.table.cohort') },
  { key: 'size', label: t('adminStats.table.size'), numeric: true },
  ...Array.from({ length: weeks.value }, (_, k) => ({ key: `w${k}`, label: t('adminStats.table.week', { n: k }), numeric: true }))
])
const csvRows = computed(() => props.cohorts.map(c => ({
  week: c.week,
  size: c.size,
  ...Object.fromEntries(c.retention.map((v, k) => [`w${k}`, v]))
})))

function download(): void {
  const csv = toCsv(csvColumns.value.map(c => c.label), csvRows.value.map(r => csvColumns.value.map(c => (r as Record<string, number | string | null>)[c.key] ?? null)))
  downloadCsv(csvFileName('retention', props.range, new Date().toISOString().slice(0, 10)), csv)
}
</script>

<template>
  <section
    class="rounded-md bg-default p-4 break-inside-avoid print:border print:border-default"
    data-testid="admin-stats-cohorts"
  >
    <div class="flex items-center justify-between gap-3 mb-1">
      <h3 class="text-sm text-default">
        {{ t('adminStats.section.retention') }}
      </h3>
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-download"
        class="print:hidden"
        @click="download"
      >
        {{ t('adminStats.csv') }}
      </UButton>
    </div>
    <p class="text-xs text-muted mb-3">
      {{ t('adminStats.section.retentionHint') }}
    </p>
    <div class="overflow-x-auto">
      <table class="text-xs tabular-nums border-separate border-spacing-0.5">
        <thead>
          <tr class="text-muted">
            <th class="text-left font-normal pr-2">
              {{ t('adminStats.table.cohort') }}
            </th>
            <th class="text-right font-normal pr-2">
              {{ t('adminStats.table.size') }}
            </th>
            <th
              v-for="k in weeks"
              :key="k"
              class="font-normal w-11 text-center"
            >
              {{ t('adminStats.table.week', { n: k - 1 }) }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="c in cohorts"
            :key="c.week"
          >
            <td class="pr-2 whitespace-nowrap text-default">
              {{ statsBucketLabel(c.week, 'week', locale) }}
            </td>
            <td class="pr-2 text-right text-muted">
              {{ statsCount(c.size, locale) }}
            </td>
            <td
              v-for="(v, k) in c.retention"
              :key="k"
              class="rounded-sm text-center h-7"
              :style="cellStyle(v)"
            >
              {{ v === null ? '' : `${Math.round(v)}` }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
