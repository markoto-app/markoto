<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

// Shown while items are selected: how many, the selection's actions (the
// keyboard and touch path to everything the context menu offers), clear.

defineProps<{
  count: number
  actions: DropdownMenuItem[][]
}>()
const emit = defineEmits<{ clear: [] }>()
const { t } = useI18n()
</script>

<template>
  <div
    class="flex items-center gap-2 text-sm rounded-md border border-default bg-default px-3 py-1.5"
    data-testid="explorer-selection-bar"
  >
    <span>{{ t('explorer.selected', { n: count }, count) }}</span>
    <div class="flex-1" />
    <UDropdownMenu :items="actions">
      <UButton
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-more-horizontal"
        data-testid="explorer-selection-actions"
      >
        {{ t('explorer.actions') }}
      </UButton>
    </UDropdownMenu>
    <UButton
      size="xs"
      color="neutral"
      variant="ghost"
      icon="i-lucide-x"
      :aria-label="t('explorer.clearSelection')"
      @click="emit('clear')"
    />
  </div>
</template>
