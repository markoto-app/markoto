<script setup lang="ts">
import type { DocTheme } from '~~/shared/types/theme'

// Theme panel → Colour: brand (links, marks) and secondary (hairlines, leaders).
const theme = defineModel<DocTheme>('theme', { required: true })
const { t } = useI18n()
</script>

<template>
  <div class="space-y-4 pt-2 pb-4">
    <UFormField
      :label="t('theme.color.brand')"
      :help="t('theme.color.brandHelp')"
    >
      <DocumentThemeColorField
        v-model="theme.color.brand"
        testid="theme-color-brand-trigger"
      />
    </UFormField>
    <UFormField
      :label="t('theme.color.secondary')"
      :help="t('theme.color.secondaryHelp')"
    >
      <DocumentThemeColorField v-model="theme.color.secondary" />
    </UFormField>
  </div>
</template>
