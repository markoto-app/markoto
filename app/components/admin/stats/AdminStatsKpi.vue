<script setup lang="ts">
import type { Kpi } from '~~/shared/contracts/adminStats'

// One number tile: label, value, and the change against the previous
// period when there is one. Growth is shown in the success colour; for a
// number where less is better (`lowerIsBetter`) the colours swap.
const props = defineProps<{
  label: string
  value: string
  kpi?: Kpi | null
  hint?: string | null
  lowerIsBetter?: boolean
}>()

const { t, locale } = useI18n()
const change = computed(() => props.kpi ? statsChange(props.kpi, locale.value) : null)
const changeClass = computed(() => {
  const dir = change.value?.direction
  if (!dir || dir === 'flat') return 'text-muted'
  const good = props.lowerIsBetter ? dir === 'down' : dir === 'up'
  return good ? 'text-success' : 'text-error'
})
const changeIcon = computed(() => {
  const dir = change.value?.direction
  if (dir === 'up') return 'i-lucide-arrow-up-right'
  if (dir === 'down') return 'i-lucide-arrow-down-right'
  return 'i-lucide-arrow-right'
})
</script>

<template>
  <div
    class="h-full rounded-md bg-default p-4 break-inside-avoid print:border print:border-default print:p-3"
    data-testid="admin-stats-kpi"
  >
    <div class="text-xs text-muted mb-1">
      {{ label }}
    </div>
    <div class="font-serif text-2xl font-normal tracking-tight text-default tabular-nums">
      {{ value }}
    </div>
    <div
      v-if="change"
      class="mt-1 flex items-center gap-1 text-xs"
      :class="changeClass"
    >
      <UIcon
        :name="changeIcon"
        class="size-3.5"
      />
      <span>{{ change.text }}</span>
      <span class="text-muted">{{ t('adminStats.change.vsPrevious') }}</span>
    </div>
    <div
      v-if="hint"
      class="mt-1 text-xs text-muted"
    >
      {{ hint }}
    </div>
  </div>
</template>
