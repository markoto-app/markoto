<script setup lang="ts">
import type { DocTheme, MermaidTheme } from '~~/shared/types/theme'

// Theme panel → Diagrams: the Mermaid theme.
const theme = defineModel<DocTheme>('theme', { required: true })
const { t } = useI18n()

const mermaidThemeItems = computed<Array<{ label: string, value: MermaidTheme }>>(() => [
  { label: t('theme.mermaid.themeDocument'), value: 'document' },
  { label: t('theme.mermaid.themeDefault'), value: 'default' },
  { label: t('theme.mermaid.themeDark'), value: 'dark' },
  { label: t('theme.mermaid.themeForest'), value: 'forest' },
  { label: t('theme.mermaid.themeNeutral'), value: 'neutral' },
  { label: t('theme.mermaid.themeBase'), value: 'base' }
])
</script>

<template>
  <div class="space-y-4 pt-2 pb-4">
    <UFormField
      :label="t('theme.mermaid.theme')"
      :help="t('theme.mermaid.themeHelp')"
    >
      <USelect
        v-model="theme.mermaid.theme"
        :items="mermaidThemeItems"
        class="w-full"
      />
    </UFormField>
  </div>
</template>
