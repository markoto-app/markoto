<script setup lang="ts">
import type { DocTheme, CodeBackground, CodeFrame, CodeTheme } from '~~/shared/types/theme'
import { CODE_FONT_NAMES } from '~~/shared/utils/theme/themeFonts'
import { CODE_OPTION_DEFAULTS } from '~~/shared/utils/theme/themeOptions'

// Theme panel → Code: highlighting theme, size, font, background, frame, wrapping, line numbers.
const theme = defineModel<DocTheme>('theme', { required: true })
const { t } = useI18n()

const codeThemeItems = computed<Array<{ label: string, value: CodeTheme }>>(() => [
  { label: 'GitHub Light', value: 'github-light' },
  { label: 'GitHub Dark', value: 'github-dark' },
  { label: 'Monokai', value: 'monokai' },
  { label: 'Dracula', value: 'dracula' },
  { label: 'Solarized Light', value: 'solarized-light' },
  { label: 'Solarized Dark', value: 'solarized-dark' },
  { label: t('theme.code.none'), value: 'none' }
])
/**
 * SYSTEM_CODE_FONT stands for "system monospace" in the picker (the field
 * is then absent). Not '': Reka's SelectItem refuses an empty value.
 */
const SYSTEM_CODE_FONT = 'system-monospace'
const codeFontModel = computed({
  get: () => theme.value.code.font ?? SYSTEM_CODE_FONT,
  set: (v: string) => {
    if (v && v !== SYSTEM_CODE_FONT) theme.value.code.font = v
    else delete theme.value.code.font
  }
})
const codeFontItems = computed(() => [
  { label: t('theme.code.fontSystem'), value: SYSTEM_CODE_FONT },
  ...CODE_FONT_NAMES.map(name => ({ label: name, value: name }))
])
const codeBackgroundModel = computed({
  get: () => theme.value.code.background ?? CODE_OPTION_DEFAULTS.background,
  set: (v: CodeBackground) => { theme.value.code.background = v }
})
const codeBackgroundItems = computed<Array<{ label: string, value: CodeBackground }>>(() => [
  { label: t('theme.code.backgroundAuto'), value: 'auto' },
  { label: t('theme.code.backgroundTint'), value: 'tint' },
  { label: t('theme.code.backgroundNone'), value: 'none' }
])
const codeFrameModel = computed({
  get: () => theme.value.code.frame ?? CODE_OPTION_DEFAULTS.frame,
  set: (v: CodeFrame) => { theme.value.code.frame = v }
})
const codeFrameItems = computed<Array<{ label: string, value: CodeFrame }>>(() => [
  { label: t('theme.code.frameNone'), value: 'none' },
  { label: t('theme.code.frameRule'), value: 'rule' },
  { label: t('theme.code.frameBox'), value: 'box' }
])
const codeWrapModel = computed({
  get: () => theme.value.code.wrap ?? CODE_OPTION_DEFAULTS.wrap,
  set: (v: boolean) => { theme.value.code.wrap = v }
})
const codeLineNumbersModel = computed({
  get: () => theme.value.code.lineNumbers ?? CODE_OPTION_DEFAULTS.lineNumbers,
  set: (v: boolean) => { theme.value.code.lineNumbers = v }
})
</script>

<template>
  <div class="space-y-4 pt-2 pb-4">
    <UFormField :label="t('theme.code.theme')">
      <USelect
        v-model="theme.code.theme"
        :items="codeThemeItems"
        class="w-full"
      />
    </UFormField>
    <UFormField :label="t('theme.code.fontSize')">
      <UInputNumber
        v-model="theme.code.fontSize"
        :min="6"
        :max="16"
        :step="0.5"
        class="w-full"
      />
    </UFormField>
    <UFormField :label="t('theme.code.font')">
      <USelect
        v-model="codeFontModel"
        :items="codeFontItems"
        class="w-full"
      />
    </UFormField>
    <UFormField
      :label="t('theme.code.background')"
      :help="t('theme.code.backgroundHelp')"
    >
      <USelect
        v-model="codeBackgroundModel"
        :items="codeBackgroundItems"
        class="w-full"
      />
    </UFormField>
    <UFormField :label="t('theme.code.frame')">
      <USelect
        v-model="codeFrameModel"
        :items="codeFrameItems"
        class="w-full"
        data-testid="theme-code-frame"
      />
    </UFormField>
    <UFormField
      :label="t('theme.code.wrap')"
      :help="t('theme.code.wrapHelp')"
    >
      <USwitch v-model="codeWrapModel" />
    </UFormField>
    <UFormField :label="t('theme.code.lineNumbers')">
      <USwitch v-model="codeLineNumbersModel" />
    </UFormField>
  </div>
</template>
