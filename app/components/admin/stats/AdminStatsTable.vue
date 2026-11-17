<script setup lang="ts">
import type { CsvCell } from '~/utils/admin/csv'

// A small table with a "Download CSV" button. `rows` hold what the table
// shows; `csvRows` (same column order) the raw numbers for the file, so a
// spreadsheet gets 1234.5, not "1,234.50 CHF".

export interface StatsColumn {
  key: string
  label: string
  numeric?: boolean
}

const props = defineProps<{
  title: string
  name: string
  range: string
  columns: StatsColumn[]
  rows: Array<Record<string, string | number | null>>
  csvRows?: Array<Record<string, CsvCell>>
}>()

const { t } = useI18n()

function download(): void {
  const source = props.csvRows ?? props.rows
  const csv = toCsv(props.columns.map(c => c.label), source.map(r => props.columns.map(c => r[c.key] ?? null)))
  downloadCsv(csvFileName(props.name, props.range, new Date().toISOString().slice(0, 10)), csv)
}
</script>

<template>
  <section class="rounded-md bg-default p-4 break-inside-avoid">
    <div class="flex items-center justify-between gap-3 mb-3">
      <h3 class="text-sm text-default">
        {{ title }}
      </h3>
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-download"
        class="print:hidden"
        :data-testid="`admin-stats-csv-${name}`"
        @click="download"
      >
        {{ t('adminStats.csv') }}
      </UButton>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-xs text-muted border-b border-default">
            <th
              v-for="c in columns"
              :key="c.key"
              class="py-2 pr-3 font-normal"
              :class="c.numeric ? 'text-right' : ''"
            >
              {{ c.label }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(r, i) in rows"
            :key="i"
            class="border-b border-default last:border-0"
          >
            <td
              v-for="c in columns"
              :key="c.key"
              class="py-2 pr-3"
              :class="c.numeric ? 'text-right tabular-nums' : 'text-default'"
            >
              {{ r[c.key] ?? '' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
