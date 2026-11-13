<script setup lang="ts">
import type { DocTheme } from '~~/shared/types/theme'
import type { BrandKit } from '~/utils/api/types/brandKit'
import { repeatTitle, resolveTitleBlock } from '~~/shared/utils/theme/themeOptions'
import { useCoverDate, useCoverDateFormat, useFontWeightItems } from '~/composables/document/themeFieldOptions'

// Theme panel → Cover page (title sheet): layout, title sizes, which parts
// show, the logo and the authors.
defineProps<{
  docId: string
  brandImages: BrandKit['images']
}>()
const theme = defineModel<DocTheme>('theme', { required: true })
const { t } = useI18n()

const coverLayoutItems = computed(() => [
  { label: t('theme.cover.layoutClassic'), value: 'classic' },
  { label: t('theme.cover.layoutEditorial'), value: 'editorial' },
  { label: t('theme.cover.layoutBanner'), value: 'banner' },
  { label: t('theme.cover.layoutMinimal'), value: 'minimal' },
  { label: t('theme.cover.layoutTitleBlock'), value: 'title-block' }
])
const coverAlignItems = computed(() => [
  { label: t('theme.align.left'), value: 'left' },
  { label: t('theme.align.center'), value: 'center' },
  { label: t('theme.align.right'), value: 'right' }
])

// Optional fields: read through their defaults, written only on change.
const coverRules = computed({
  get: () => resolveTitleBlock(theme.value).rules,
  set: (v: boolean) => { theme.value.cover.rules = v }
})
const coverSmallCaps = computed({
  get: () => resolveTitleBlock(theme.value).smallCaps,
  set: (v: boolean) => { theme.value.cover.smallCaps = v }
})
const coverRepeatTitleModel = computed({
  get: () => repeatTitle(theme.value),
  set: (v: boolean) => { theme.value.cover.repeatTitle = v }
})
const coverDate = useCoverDate(theme)
const { model: coverDateFormatModel, items: coverDateFormatItems } = useCoverDateFormat(theme)

/** 0 = "same as the headings" (the field is then absent). */
const coverTitleWeightModel = computed({
  get: () => theme.value.cover.titleWeight ?? 0,
  set: (v: number) => {
    if (v) theme.value.cover.titleWeight = v
    else delete theme.value.cover.titleWeight
  }
})
const fontWeightItems = useFontWeightItems()
const coverTitleWeightItems = computed(() => [
  { label: t('theme.cover.titleWeightInherit', { weight: theme.value.headings.weight }), value: 0 },
  ...fontWeightItems.value
])
</script>

<template>
  <div class="space-y-4 pt-2 pb-4">
    <UFormField
      :label="t('theme.cover.enabled')"
      :help="t('theme.cover.enabledHelp')"
    >
      <USwitch
        v-model="theme.cover.enabled"
        data-testid="theme-cover-enabled-switch"
      />
    </UFormField>
    <template v-if="theme.cover.enabled">
      <UFormField :label="t('theme.cover.layout')">
        <USelect
          v-model="theme.cover.layout"
          :items="coverLayoutItems"
          class="w-full"
          data-testid="theme-cover-layout-select"
        />
      </UFormField>
      <UFormField :label="t('theme.cover.align')">
        <USelect
          v-model="theme.cover.align"
          :items="coverAlignItems"
          class="w-full"
          data-testid="theme-cover-align-select"
        />
      </UFormField>
      <UFormField
        :label="t('theme.cover.titleSize')"
        :help="`${theme.cover.titleSize.toFixed(2)}em`"
      >
        <USlider
          v-model="theme.cover.titleSize"
          :min="0.6"
          :max="4"
          :step="0.05"
        />
      </UFormField>
      <UFormField
        v-if="theme.cover.showSubtitle"
        :label="t('theme.cover.subtitleSize')"
        :help="`${theme.cover.subtitleSize.toFixed(2)}em`"
      >
        <USlider
          v-model="theme.cover.subtitleSize"
          :min="0.5"
          :max="2.5"
          :step="0.05"
        />
      </UFormField>
      <UFormField
        v-if="theme.cover.layout === 'title-block'"
        :label="t('theme.cover.rules')"
        :help="t('theme.cover.rulesHelp')"
      >
        <USwitch v-model="coverRules" />
      </UFormField>
      <UFormField :label="t('theme.cover.smallCaps')">
        <USwitch v-model="coverSmallCaps" />
      </UFormField>
      <UFormField :label="t('theme.cover.titleWeight')">
        <USelect
          v-model="coverTitleWeightModel"
          :items="coverTitleWeightItems"
          class="w-full"
          data-testid="theme-cover-title-weight"
        />
      </UFormField>
      <p
        v-if="theme.cover.layout === 'title-block'"
        class="text-xs text-muted"
      >
        {{ t('theme.cover.titleBlockHelp') }}
      </p>
      <UFormField :label="t('theme.cover.showTitle')">
        <USwitch v-model="theme.cover.showTitle" />
      </UFormField>
      <UFormField :label="t('theme.cover.showSubtitle')">
        <USwitch
          v-model="theme.cover.showSubtitle"
          data-testid="theme-cover-show-subtitle-switch"
        />
      </UFormField>
      <UFormField
        v-if="theme.cover.showSubtitle"
        :label="t('theme.cover.subtitle')"
      >
        <UInput
          v-model="theme.cover.subtitle"
          maxlength="200"
          class="w-full"
          data-testid="theme-cover-subtitle-input"
        />
      </UFormField>
      <UFormField :label="t('theme.cover.showDate')">
        <USwitch v-model="theme.cover.showDate" />
      </UFormField>
      <UFormField
        :label="t('theme.cover.date')"
        :help="t('theme.cover.dateHelp')"
      >
        <div class="flex items-center gap-2">
          <UInput
            v-model="coverDate"
            type="date"
            class="flex-1"
            data-testid="theme-cover-date-input"
          />
          <UButton
            v-if="coverDate"
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="sm"
            :aria-label="t('theme.cover.dateClear')"
            @click="coverDate = ''"
          />
        </div>
      </UFormField>
      <UFormField :label="t('theme.cover.dateFormat')">
        <USelect
          v-model="coverDateFormatModel"
          :items="coverDateFormatItems"
          class="w-full"
          data-testid="theme-cover-date-format"
        />
      </UFormField>
      <UFormField
        :label="t('theme.cover.repeatTitle')"
        :help="t('theme.cover.repeatTitleHelp')"
      >
        <USwitch
          v-model="coverRepeatTitleModel"
          data-testid="theme-cover-repeat-title"
        />
      </UFormField>
      <UFormField :label="t('theme.cover.showAuthors')">
        <USwitch
          v-model="theme.cover.showAuthors"
          data-testid="theme-cover-show-authors-switch"
        />
      </UFormField>
      <UFormField :label="t('theme.cover.showLogo')">
        <USwitch v-model="theme.cover.showLogo" />
      </UFormField>
      <UFormField
        v-if="theme.cover.showLogo"
        :label="t('theme.brand.logo')"
        :help="t('theme.brand.logoHelp')"
      >
        <DocumentThemeCoverLogoField
          v-model:theme="theme"
          :doc-id="docId"
          :brand-images="brandImages"
        />
      </UFormField>
      <UFormField
        v-if="theme.cover.showLogo && theme.brand.logoUrl"
        :label="t('theme.brand.logoHeight')"
      >
        <UInputNumber
          v-model="theme.brand.logoHeight"
          :min="8"
          :max="80"
          :step="2"
          class="w-full"
        />
      </UFormField>
      <UFormField
        v-if="theme.cover.showAuthors"
        :label="t('theme.cover.authors')"
        :help="t('theme.cover.authorsHelp')"
      >
        <DocumentThemeAuthorsField
          v-model:theme="theme"
          affiliation-testids
        />
      </UFormField>
    </template>
  </div>
</template>
