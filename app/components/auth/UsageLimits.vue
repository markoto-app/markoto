<script setup lang="ts">
// "Storage & limits" section of the topbar usage popover: image
// storage, knowledge files, knowledge storage and owned workspaces,
// each as "used / limit" with a thin bar coloured by fill
// (`usageFill`: the AI-points badge thresholds, inverted).

import type { UserBilling } from '~/composables/billing/useBilling'
import { formatBytes, usageFill, USAGE_LEVEL_BAR_CLASS, type UsageFill } from '~/utils/billing/usageMeter'

const props = defineProps<{ billing: UserBilling }>()

const { t, locale } = useAreaI18n()

interface LimitRow {
  key: 'images' | 'knowledgeFiles' | 'knowledgeStorage' | 'workspaces'
  label: string
  used: string
  limit: string
  fill: UsageFill
}

function count(n: number): string {
  return n.toLocaleString(locale.value)
}

function row(
  key: LimitRow['key'],
  used: number,
  limit: number | null,
  format: (n: number) => string
): LimitRow {
  const fill = usageFill(used, limit)
  return {
    key,
    label: t(`topbar.limits.${key}`),
    used: format(used),
    limit: fill.unlimited || limit === null ? t('topbar.limits.unlimited') : format(limit),
    fill
  }
}

const rows = computed((): LimitRow[] => {
  const b = props.billing
  return [
    row('images', b.imageBytesUsed, b.imageBytesPerUserLimit, formatBytes),
    row('knowledgeFiles', b.knowledgeFilesUsed, b.knowledgeFilesLimit, count),
    row('knowledgeStorage', b.knowledgeBytesUsed, b.knowledgeBytesPerUserLimit, formatBytes),
    row('workspaces', b.ownedWorkspaces, b.workspacesOwnedLimit, count)
  ]
})
</script>

<template>
  <div
    class="space-y-2"
    data-testid="usage-limits"
  >
    <h3 class="font-mono text-[11px] uppercase tracking-wider text-muted">
      {{ t('topbar.limits.title') }}
    </h3>
    <div
      v-for="r in rows"
      :key="r.key"
      :data-testid="`usage-limit-${r.key}`"
      :data-level="r.fill.level"
      :data-unlimited="r.fill.unlimited ? 'true' : undefined"
    >
      <div class="flex items-baseline justify-between gap-2 text-xs mb-1">
        <span class="text-muted">{{ r.label }}</span>
        <span
          class="tabular-nums text-default"
          data-testid="usage-limit-value"
        >
          {{ r.used }} <span class="text-muted">/ {{ r.limit }}</span>
        </span>
      </div>
      <div class="relative h-1 w-full rounded-full bg-muted/30 overflow-hidden">
        <div
          class="absolute inset-y-0 left-0 transition-all"
          :class="USAGE_LEVEL_BAR_CLASS[r.fill.level]"
          :style="{ width: r.fill.pct + '%' }"
          data-testid="usage-limit-bar"
        />
      </div>
    </div>
  </div>
</template>
