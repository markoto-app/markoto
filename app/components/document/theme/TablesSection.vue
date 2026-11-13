<script setup lang="ts">
import type { DocTheme, CaptionPosition } from '~~/shared/types/theme'
import { resolveCaptions } from '~~/shared/utils/theme/themeOptions'

// Theme panel → Tables: header row, borders, zebra, padding, caption position and label.
const theme = defineModel<DocTheme>('theme', { required: true })
const { t } = useI18n()

const tableHeaderBgItems = computed(() => [
  { label: t('theme.tables.headerBgBrand'), value: 'brand' },
  { label: t('theme.tables.headerBgMuted'), value: 'muted' },
  { label: t('theme.tables.headerBgNone'), value: 'none' }
])
const tableHeaderColorItems = computed(() => [
  { label: t('theme.tables.headerColorAuto'), value: 'auto' },
  { label: t('theme.tables.headerColorInherit'), value: 'inherit' }
])
const tableBordersItems = computed(() => [
  { label: t('theme.tables.bordersAll'), value: 'all' },
  { label: t('theme.tables.bordersHorizontal'), value: 'horizontal' },
  { label: t('theme.tables.bordersMinimal'), value: 'minimal' },
  { label: t('theme.tables.bordersNone'), value: 'none' }
])
const captionPositionItems = computed<Array<{ label: string, value: CaptionPosition }>>(() => [
  { label: t('theme.tables.captionAbove'), value: 'above' },
  { label: t('theme.tables.captionBelow'), value: 'below' }
])
// Optional fields (see themeOptions).
const tableCaptionPositionModel = computed({
  get: () => resolveCaptions(theme.value).tablePosition,
  set: (v: CaptionPosition) => { theme.value.tables.captionPosition = v }
})
const tableCaptionLabelModel = computed({
  get: () => resolveCaptions(theme.value).tableLabel,
  set: (v: boolean) => { theme.value.tables.captionLabel = v }
})
</script>

<template>
  <div class="space-y-4 pt-2 pb-4">
    <UFormField :label="t('theme.tables.headerBackground')">
      <USelect
        v-model="theme.tables.headerBackground"
        :items="tableHeaderBgItems"
        class="w-full"
      />
    </UFormField>
    <UFormField
      v-if="theme.tables.headerBackground !== 'none'"
      :label="t('theme.tables.headerTextColor')"
      :help="t('theme.tables.headerTextColorHelp')"
    >
      <USelect
        v-model="theme.tables.headerTextColor"
        :items="tableHeaderColorItems"
        class="w-full"
      />
    </UFormField>
    <UFormField :label="t('theme.tables.borders')">
      <USelect
        v-model="theme.tables.borders"
        :items="tableBordersItems"
        class="w-full"
      />
    </UFormField>
    <UFormField
      :label="t('theme.tables.zebra')"
      :help="t('theme.tables.zebraHelp')"
    >
      <USwitch v-model="theme.tables.zebra" />
    </UFormField>
    <UFormField :label="t('theme.tables.cellPadding')">
      <UInputNumber
        v-model="theme.tables.cellPadding"
        :min="0"
        :max="24"
        :step="1"
        class="w-full"
      />
    </UFormField>
    <UFormField
      :label="t('theme.tables.captionPosition')"
      :help="t('theme.tables.captionPositionHelp', { code: 'Table: …' })"
    >
      <USelect
        v-model="tableCaptionPositionModel"
        :items="captionPositionItems"
        class="w-full"
        data-testid="theme-tables-caption-position"
      />
    </UFormField>
    <UFormField
      :label="t('theme.tables.captionLabel')"
      :help="t('theme.tables.captionLabelHelp')"
    >
      <USwitch
        v-model="tableCaptionLabelModel"
        data-testid="theme-tables-caption-label"
      />
    </UFormField>
  </div>
</template>
