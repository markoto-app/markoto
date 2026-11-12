<script setup lang="ts">
import type { DocTheme } from '~~/shared/types/theme'

// Theme panel → Alerts: the colour of each GitHub alert kind.
const theme = defineModel<DocTheme>('theme', { required: true })
const { t } = useI18n()
</script>

<template>
  <div class="space-y-4 pt-2 pb-4">
    <p class="text-xs text-muted">
      {{ t('theme.alerts.help') }}
    </p>
    <UFormField
      v-for="kind in (['note', 'tip', 'important', 'warning', 'caution'] as const)"
      :key="kind"
      :label="t(`theme.alerts.${kind}`)"
    >
      <DocumentThemeColorField v-model="theme.alerts[kind]" />
    </UFormField>
  </div>
</template>
