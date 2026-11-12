<script setup lang="ts">
import type { DocTheme, HeadingNumbering, NumberingDepth } from '~~/shared/types/theme'
import { headingNumbering, numberingDepth, resolveChapterLabel } from '~~/shared/utils/theme/themeOptions'
import { useFontWeightItems } from '~/composables/document/themeFieldOptions'

// Theme panel → Headings: font, scale, numbering, weight, colour, spacing,
// and the per-level overrides (DocumentThemeHeadingLevels).
defineProps<{
  fontItems: Array<{ type?: 'label', label: string, value: string }>
}>()
const theme = defineModel<DocTheme>('theme', { required: true })
const { t } = useI18n()

// h1 = body × scale³ (themeToCss HEADING_SCALE_EXPONENTS); the label
// says what that means on the page. A stored value outside the list is
// added so the select never shows blank.
const HEADING_SCALES = [1.12, 1.15, 1.18, 1.2, 1.22, 1.25, 1.28, 1.333, 1.414]
const headingScaleItems = computed(() => {
  const values = HEADING_SCALES.includes(theme.value.headings.scale)
    ? HEADING_SCALES
    : [...HEADING_SCALES, theme.value.headings.scale].sort((a, b) => a - b)
  return values.map(value => ({
    label: t('theme.headings.scaleOption', { ratio: value.toFixed(3).replace(/0$/, ''), h1: Math.pow(value, 3).toFixed(1) }),
    value
  }))
})
const headingWeightItems = useFontWeightItems([400, 500, 600, 700, 800, 900])
const headingNumberingItems = computed<Array<{ label: string, value: HeadingNumbering }>>(() => [
  { label: t('theme.headings.numberingNone'), value: 'none' },
  { label: t('theme.headings.numberingDecimal'), value: 'decimal' },
  { label: t('theme.headings.numberingDecimalDot'), value: 'decimal-dot' },
  { label: t('theme.headings.numberingIeee'), value: 'ieee' },
  { label: t('theme.headings.numberingDecimalZero'), value: 'decimal-zero' }
])
const headingNumberingModel = computed({
  get: () => headingNumbering(theme.value),
  set: (v: HeadingNumbering) => { theme.value.headings.numbering = v }
})
const numberingDepthModel = computed({
  get: () => numberingDepth(theme.value),
  set: (v: NumberingDepth) => { theme.value.headings.numberingDepth = v }
})
const numberingDepthItems = computed<Array<{ label: string, value: NumberingDepth }>>(() => [
  { label: t('theme.headings.numberingDepth1'), value: 1 },
  { label: t('theme.headings.numberingDepthN', { n: 2 }), value: 2 },
  { label: t('theme.headings.numberingDepthN', { n: 3 }), value: 3 },
  { label: t('theme.headings.numberingDepthAll'), value: 4 }
])
const chapterLabelModel = computed({
  get: () => resolveChapterLabel(theme.value).enabled,
  set: (v: boolean) => { theme.value.headings.chapterLabel = v }
})
const chapterWordModel = computed({
  get: () => resolveChapterLabel(theme.value).word,
  // The schema refuses quotes, backslashes, angle brackets and newlines (CSS string).
  set: (v: string) => { theme.value.headings.chapterWord = v.replace(/["\\<>\r\n]/g, '').slice(0, 40) }
})
</script>

<template>
  <div class="space-y-4 pt-2 pb-4">
    <UFormField :label="t('theme.headings.font')">
      <DocumentThemeFontSelect
        v-model="theme.headings.font"
        :items="fontItems"
      />
    </UFormField>
    <UFormField :label="t('theme.headings.scale')">
      <USelect
        v-model="theme.headings.scale"
        :items="headingScaleItems"
        class="w-full"
      />
    </UFormField>
    <UFormField
      :label="t('theme.headings.numbering')"
      :help="t('theme.headings.numberingHelp', { code: '{.unnumbered}' })"
    >
      <USelect
        v-model="headingNumberingModel"
        :items="headingNumberingItems"
        class="w-full"
        data-testid="theme-headings-numbering"
      />
    </UFormField>
    <template v-if="headingNumberingModel !== 'none'">
      <UFormField :label="t('theme.headings.numberingDepth')">
        <USelect
          v-model="numberingDepthModel"
          :items="numberingDepthItems"
          class="w-full"
          data-testid="theme-headings-numbering-depth"
        />
      </UFormField>
      <UFormField
        :label="t('theme.headings.chapterLabel')"
        :help="t('theme.headings.chapterLabelHelp')"
      >
        <USwitch
          v-model="chapterLabelModel"
          data-testid="theme-headings-chapter-label"
        />
      </UFormField>
      <UFormField
        v-if="chapterLabelModel"
        :label="t('theme.headings.chapterWord')"
        :help="t('theme.headings.chapterWordHelp')"
      >
        <UInput
          v-model="chapterWordModel"
          maxlength="40"
          :placeholder="t('theme.headings.chapterWordPlaceholder')"
          class="w-full"
          data-testid="theme-headings-chapter-word"
        />
      </UFormField>
    </template>
    <UFormField :label="t('theme.headings.weight')">
      <USelect
        v-model="theme.headings.weight"
        :items="headingWeightItems"
        class="w-full"
      />
    </UFormField>
    <UFormField
      :label="t('theme.headings.color')"
      :help="t('theme.headings.colorHelp')"
    >
      <DocumentThemeColorField v-model="theme.headings.color" />
    </UFormField>
    <UFormField :label="t('theme.headings.underline')">
      <USwitch v-model="theme.headings.underline" />
    </UFormField>
    <UFormField :label="t('theme.headings.letterSpacing')">
      <UInputNumber
        v-model="theme.headings.letterSpacing"
        :min="-0.05"
        :max="0.1"
        :step="0.005"
        class="w-full"
      />
    </UFormField>
    <UFormField :label="t('theme.headings.lineHeight')">
      <UInputNumber
        v-model="theme.headings.lineHeight"
        :min="0.9"
        :max="1.6"
        :step="0.05"
        class="w-full"
      />
    </UFormField>
    <UFormField
      :label="t('theme.headings.spacingScale')"
      :help="t('theme.headings.spacingScaleHelp')"
    >
      <UInputNumber
        v-model="theme.headings.spacingScale"
        :min="0.5"
        :max="2"
        :step="0.1"
        class="w-full"
      />
    </UFormField>
    <!-- Per-level look (headings.levels): collapsed unless the
         theme already overrides a level. -->
    <DocumentThemeHeadingLevels v-model:theme="theme" />
  </div>
</template>
