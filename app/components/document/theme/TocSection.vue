<script setup lang="ts">
import type { DocTheme, TocLeaderStyle, TocMaxDepth } from '~~/shared/types/theme'

// Theme panel → Table of contents.
const theme = defineModel<DocTheme>('theme', { required: true })
const { t } = useI18n()

const tocMaxDepthItems = computed<Array<{ label: string, value: TocMaxDepth }>>(() => [
  { label: t('theme.toc.depth2'), value: 2 },
  { label: t('theme.toc.depth3'), value: 3 },
  { label: t('theme.toc.depth4'), value: 4 }
])
const tocLeaderItems = computed<Array<{ label: string, value: TocLeaderStyle }>>(() => [
  { label: t('theme.toc.leaderDotted'), value: 'dotted' },
  { label: t('theme.toc.leaderDashed'), value: 'dashed' },
  { label: t('theme.toc.leaderNone'), value: 'none' }
])
</script>

<template>
  <div class="space-y-4 pt-2 pb-4">
    <UFormField
      :label="t('theme.toc.showTitle')"
      :help="t('theme.toc.showTitleHelp')"
    >
      <USwitch v-model="theme.toc.showTitle" />
    </UFormField>
    <UFormField
      :label="t('theme.toc.maxDepth')"
      :help="t('theme.toc.maxDepthHelp')"
    >
      <USelect
        v-model="theme.toc.maxDepth"
        :items="tocMaxDepthItems"
        class="w-full"
      />
    </UFormField>
    <UFormField
      :label="t('theme.toc.showPageNumbers')"
      :help="t('theme.toc.showPageNumbersHelp')"
    >
      <USwitch v-model="theme.toc.showPageNumbers" />
    </UFormField>
    <UFormField :label="t('theme.toc.leaderStyle')">
      <USelect
        v-model="theme.toc.leaderStyle"
        :items="tocLeaderItems"
        class="w-full"
      />
    </UFormField>
  </div>
</template>
