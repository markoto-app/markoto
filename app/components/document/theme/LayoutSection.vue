<script setup lang="ts">
import type { DocTheme } from '~~/shared/types/theme'

// Theme panel → Layout: columns and the gap between them.
const theme = defineModel<DocTheme>('theme', { required: true })
const { t } = useI18n()

const columnItems = computed(() => [
  { label: `1 ${t('theme.column')}`, value: 1 },
  { label: `2 ${t('theme.columns')}`, value: 2 },
  { label: `3 ${t('theme.columns')}`, value: 3 }
])
</script>

<template>
  <div class="space-y-4 pt-2 pb-4">
    <UFormField :label="t('theme.layout.columns')">
      <USelect
        v-model="theme.layout.columns"
        :items="columnItems"
        class="w-full"
      />
    </UFormField>
    <UFormField
      v-if="theme.layout.columns > 1"
      :label="t('theme.layout.columnGap')"
    >
      <UInputNumber
        v-model="theme.layout.columnGap"
        :min="0"
        :max="30"
        :step="1"
        class="w-full"
      />
    </UFormField>
  </div>
</template>
