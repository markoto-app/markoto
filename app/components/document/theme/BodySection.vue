<script setup lang="ts">
import type { DocTheme } from '~~/shared/types/theme'

// Theme panel → Body text: font, size, alignment, colours, drop cap, spacing.
defineProps<{
  /** Font picker items: workspace fonts, then the built-in sans and serif families. */
  fontItems: Array<{ type?: 'label', label: string, value: string }>
}>()
const theme = defineModel<DocTheme>('theme', { required: true })
const { t } = useI18n()

const textAlignItems = computed(() => [
  { label: t('theme.align.left'), value: 'left' },
  { label: t('theme.align.justify'), value: 'justify' }
])
// Drop cap: a switch (first paragraph) plus "every chapter".
const dropCapOnModel = computed({
  get: () => theme.value.body.dropCap !== false,
  set: (v: boolean) => { theme.value.body.dropCap = v ? (theme.value.body.dropCap || true) : false }
})
const dropCapEveryChapterModel = computed({
  get: () => theme.value.body.dropCap === 'every-chapter',
  set: (v: boolean) => { theme.value.body.dropCap = v ? 'every-chapter' : true }
})
</script>

<template>
  <div class="space-y-4 pt-2 pb-4">
    <UFormField :label="t('theme.body.font')">
      <DocumentThemeFontSelect
        v-model="theme.body.font"
        :items="fontItems"
        data-testid="theme-body-font-select"
      />
    </UFormField>
    <div class="grid grid-cols-2 gap-3">
      <UFormField :label="t('theme.body.size')">
        <UInputNumber
          v-model="theme.body.size"
          :min="6"
          :max="24"
          :step="0.5"
          class="w-full"
        />
      </UFormField>
      <UFormField :label="t('theme.body.lineHeight')">
        <UInputNumber
          v-model="theme.body.lineHeight"
          :min="0.8"
          :max="3"
          :step="0.05"
          class="w-full"
        />
      </UFormField>
    </div>
    <UFormField
      :label="t('theme.body.textAlign')"
      :help="t('theme.body.textAlignHelp')"
    >
      <USelect
        v-model="theme.body.textAlign"
        :items="textAlignItems"
        class="w-full"
      />
    </UFormField>
    <UFormField :label="t('theme.body.color')">
      <DocumentThemeColorField v-model="theme.body.color" />
    </UFormField>
    <UFormField :label="t('theme.body.background')">
      <DocumentThemeColorField v-model="theme.body.background" />
    </UFormField>
    <UFormField
      :label="t('theme.body.dropCap')"
      :help="t('theme.body.dropCapHelp')"
    >
      <USwitch
        v-model="dropCapOnModel"
        data-testid="theme-body-drop-cap-switch"
      />
    </UFormField>
    <UFormField
      v-if="dropCapOnModel"
      :label="t('theme.body.dropCapEveryChapter')"
      :help="t('theme.body.dropCapEveryChapterHelp')"
    >
      <USwitch
        v-model="dropCapEveryChapterModel"
        data-testid="theme-body-drop-cap-every-chapter"
      />
    </UFormField>
    <UFormField
      :label="t('theme.body.firstLineIndent')"
      :help="t('theme.body.firstLineIndentHelp')"
    >
      <USwitch v-model="theme.body.firstLineIndent" />
    </UFormField>
    <UFormField :label="t('theme.body.paragraphSpacing')">
      <UInputNumber
        v-model="theme.body.paragraphSpacing"
        :min="0"
        :max="2"
        :step="0.1"
        class="w-full"
      />
    </UFormField>
    <UFormField
      :label="t('theme.body.hyphenate')"
      :help="t('theme.body.hyphenateHelp')"
    >
      <USwitch v-model="theme.body.hyphenate" />
    </UFormField>
  </div>
</template>
