<script setup lang="ts">
import type { DocTheme, CaptionLabelStyle, CaptionNumbering, ReferenceStyle } from '~~/shared/types/theme'
import { referenceStyle, resolveCaptions } from '~~/shared/utils/theme/themeOptions'

// Theme panel → Blocks: images, quotes, rules, figure captions, the reference list.
const theme = defineModel<DocTheme>('theme', { required: true })
const { t } = useI18n()

const blockquoteItems = computed(() => [
  { label: t('theme.blockquote.border'), value: 'border' },
  { label: t('theme.blockquote.background'), value: 'background' },
  { label: t('theme.blockquote.none'), value: 'none' }
])
const hrStyleItems = computed(() => [
  { label: t('theme.hr.rule'), value: 'rule' },
  { label: t('theme.hr.dashed'), value: 'dashed' },
  { label: t('theme.hr.dotted'), value: 'dotted' },
  { label: t('theme.hr.asterism'), value: 'asterism' },
  { label: t('theme.hr.none'), value: 'none' }
])
// Captions + reference list (optional fields, see themeOptions).
const tableCaptionLabelModel = computed(() => resolveCaptions(theme.value).tableLabel)
const figureLabelModel = computed({
  get: () => resolveCaptions(theme.value).figureLabel,
  set: (v: boolean) => { theme.value.blocks.figureLabel = v }
})
const captionNumberingModel = computed({
  get: () => resolveCaptions(theme.value).numbering,
  set: (v: CaptionNumbering) => { theme.value.blocks.captionNumbering = v }
})
const captionNumberingItems = computed<Array<{ label: string, value: CaptionNumbering }>>(() => [
  { label: t('theme.blocks.captionNumberingDocument'), value: 'document' },
  { label: t('theme.blocks.captionNumberingChapter'), value: 'chapter' }
])
const captionLabelStyleModel = computed({
  get: () => resolveCaptions(theme.value).labelStyle,
  set: (v: CaptionLabelStyle) => { theme.value.blocks.captionLabelStyle = v }
})
const captionLabelStyleItems = computed<Array<{ label: string, value: CaptionLabelStyle }>>(() => [
  { label: t('theme.blocks.captionLabelInline'), value: 'inline' },
  { label: t('theme.blocks.captionLabelStacked'), value: 'stacked' }
])
const referenceStyleModel = computed({
  get: () => referenceStyle(theme.value),
  set: (v: ReferenceStyle) => { theme.value.blocks.referenceStyle = v }
})
const referenceStyleItems = computed<Array<{ label: string, value: ReferenceStyle }>>(() => [
  { label: t('theme.blocks.referencePlain'), value: 'plain' },
  { label: t('theme.blocks.referenceHanging'), value: 'hanging' },
  { label: t('theme.blocks.referenceBrackets'), value: 'brackets' }
])
</script>

<template>
  <div class="space-y-4 pt-2 pb-4">
    <UFormField :label="t('theme.blocks.imageRadius')">
      <UInputNumber
        v-model="theme.blocks.imageRadius"
        :min="0"
        :max="32"
        :step="1"
        class="w-full"
      />
    </UFormField>
    <UFormField :label="t('theme.blocks.imageMaxWidth')">
      <UInputNumber
        v-model="theme.blocks.imageMaxWidth"
        :min="10"
        :max="100"
        :step="5"
        class="w-full"
      />
    </UFormField>
    <UFormField :label="t('theme.blocks.blockquoteStyle')">
      <USelect
        v-model="theme.blocks.blockquoteStyle"
        :items="blockquoteItems"
        class="w-full"
      />
    </UFormField>
    <UFormField
      :label="t('theme.blocks.hrStyle')"
      :help="t('theme.blocks.hrStyleHelp')"
    >
      <USelect
        v-model="theme.blocks.hrStyle"
        :items="hrStyleItems"
        class="w-full"
      />
    </UFormField>
    <UFormField
      v-if="theme.blocks.hrStyle === 'rule' || theme.blocks.hrStyle === 'dashed' || theme.blocks.hrStyle === 'dotted'"
      :label="t('theme.blocks.hrThickness')"
    >
      <UInputNumber
        v-model="theme.blocks.hrThickness"
        :min="1"
        :max="6"
        class="w-full"
      />
    </UFormField>
    <UFormField
      :label="t('theme.blocks.figureLabel')"
      :help="t('theme.blocks.figureLabelHelp')"
    >
      <USwitch
        v-model="figureLabelModel"
        data-testid="theme-blocks-figure-label"
      />
    </UFormField>
    <template v-if="figureLabelModel || tableCaptionLabelModel">
      <UFormField
        :label="t('theme.blocks.captionNumbering')"
        :help="t('theme.blocks.captionNumberingHelp')"
      >
        <USelect
          v-model="captionNumberingModel"
          :items="captionNumberingItems"
          class="w-full"
          data-testid="theme-blocks-caption-numbering"
        />
      </UFormField>
      <UFormField :label="t('theme.blocks.captionLabelStyle')">
        <USelect
          v-model="captionLabelStyleModel"
          :items="captionLabelStyleItems"
          class="w-full"
          data-testid="theme-blocks-caption-label-style"
        />
      </UFormField>
    </template>
    <UFormField
      :label="t('theme.blocks.referenceStyle')"
      :help="t('theme.blocks.referenceStyleHelp')"
    >
      <USelect
        v-model="referenceStyleModel"
        :items="referenceStyleItems"
        class="w-full"
        data-testid="theme-blocks-reference-style"
      />
    </UFormField>
  </div>
</template>
