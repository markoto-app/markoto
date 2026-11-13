<script setup lang="ts">
import type { DocTheme } from '~~/shared/types/theme'

// Theme panel → Meta: the eyebrow font of header, footer, figure captions and footnotes.
defineProps<{
  fontItems: Array<{ type?: 'label', label: string, value: string }>
}>()
const theme = defineModel<DocTheme>('theme', { required: true })
const { t } = useI18n()
</script>

<template>
  <div class="space-y-4 pt-2 pb-4">
    <UFormField
      :label="t('theme.meta.font')"
      :help="t('theme.meta.fontHelp')"
    >
      <DocumentThemeFontSelect
        v-model="theme.meta.font"
        :items="fontItems"
      />
    </UFormField>
  </div>
</template>
