<script setup lang="ts">
import type { DocTheme, SectionMode } from '~~/shared/types/theme'
import type { BrandKit } from '~/utils/api/types/brandKit'
import { resolveSectionToken } from '~~/shared/utils/theme/themeOptions'
import { themeImagePreviewSrc, useThemeImageUpload } from '~/composables/document/useThemeImageUpload'

// Theme panel → Header: the running header's slots, the `{section}` token
// options, and the header image.
const props = defineProps<{
  docId: string
  brandImages: BrandKit['images']
}>()
const emit = defineEmits<{
  'slot-focus': [input: HTMLInputElement]
  'insert-token': [token: string]
}>()
const theme = defineModel<DocTheme>('theme', { required: true })
const { t } = useI18n()

// `{section}` options (header.sectionNumber / sectionMode), shown while a slot uses the token.
const usesSectionToken = computed(() => [theme.value.header, theme.value.footer].some(s => [s.left, s.center, s.right].some(v => v.includes('{section}'))))
const sectionNumberModel = computed({
  get: () => resolveSectionToken(theme.value).number,
  set: (v: boolean) => { theme.value.header.sectionNumber = v }
})
const sectionModeModel = computed({
  get: () => resolveSectionToken(theme.value).mode,
  set: (v: SectionMode) => { theme.value.header.sectionMode = v }
})
const sectionModeItems = computed<Array<{ label: string, value: SectionMode }>>(() => [
  { label: t('theme.runningSlots.sectionModeFirst'), value: 'first' },
  { label: t('theme.runningSlots.sectionModeStart'), value: 'start' }
])

// Header image: same presigned-PUT flow as the cover logo.
const { inputId: headerImageInputId, uploading: headerImageUploading, error: headerImageError, onFile: onHeaderImageFile } = useThemeImageUpload(() => props.docId, (url) => {
  theme.value.header.imageUrl = url
})
function clearHeaderImage() {
  theme.value.header.imageUrl = ''
}
const imagePreviewSrc = (url: string): string => themeImagePreviewSrc(url, props.docId)
const headerImagePositionItems = computed(() => [
  { label: t('theme.align.left'), value: 'left' },
  { label: t('theme.align.center'), value: 'center' },
  { label: t('theme.align.right'), value: 'right' }
])
</script>

<template>
  <div class="space-y-3 pt-2 pb-4">
    <DocumentThemeRunningSlotFields
      v-model:theme="theme"
      part="header"
      @slot-focus="el => emit('slot-focus', el)"
      @insert-token="token => emit('insert-token', token)"
    />
    <template v-if="usesSectionToken">
      <UFormField
        :label="t('theme.runningSlots.sectionNumber', { token: '{section}' })"
        :help="t('theme.runningSlots.sectionNumberHelp')"
      >
        <USwitch
          v-model="sectionNumberModel"
          data-testid="theme-header-section-number"
        />
      </UFormField>
      <UFormField
        :label="t('theme.runningSlots.sectionMode', { token: '{section}' })"
        :help="t('theme.runningSlots.sectionModeHelp')"
      >
        <USelect
          v-model="sectionModeModel"
          :items="sectionModeItems"
          class="w-full"
          data-testid="theme-header-section-mode"
        />
      </UFormField>
    </template>

    <!-- Header image: companies typically want their logo in
         the running header on every body page. The cover page's
         `@page cover-page { @top-X { content: '' } }` rules
         automatically suppress this on the cover. -->
    <USeparator />
    <UFormField
      :label="t('theme.runningSlots.image')"
      :help="t('theme.runningSlots.imageHelp')"
    >
      <div class="space-y-2">
        <div
          v-if="theme.header.imageUrl"
          class="flex items-center gap-3 p-2 border border-default rounded"
        >
          <img
            :src="imagePreviewSrc(theme.header.imageUrl)"
            :alt="t('theme.runningSlots.imagePreview')"
            class="border border-default rounded bg-default"
            :style="{ height: `${theme.header.imageHeight * 1.5}px`, maxWidth: '120px', objectFit: 'contain' }"
          >
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            size="xs"
            @click="clearHeaderImage"
          >
            {{ t('theme.brand.clearLogo') }}
          </UButton>
        </div>
        <label
          :for="headerImageInputId"
          class="relative flex rounded-md focus-within:ring-2 focus-within:ring-inverted"
        >
          <input
            :id="headerImageInputId"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            class="sr-only"
            @change="onHeaderImageFile"
          >
          <UButton
            as="span"
            color="neutral"
            variant="outline"
            icon="i-lucide-upload"
            size="xs"
            :loading="headerImageUploading"
          >
            {{ theme.header.imageUrl ? t('theme.brand.replaceLogo') : t('theme.runningSlots.uploadImage') }}
          </UButton>
        </label>
        <p
          v-if="headerImageError"
          class="text-xs text-rose-600 dark:text-rose-400"
        >
          {{ headerImageError }}
        </p>
        <DocumentThemeBrandImagePicker
          v-if="brandImages.length"
          :images="brandImages"
          :doc-id="docId"
          :selected="theme.header.imageUrl"
          @select="url => { theme.header.imageUrl = url }"
        />
      </div>
    </UFormField>
    <UFormField
      v-if="theme.header.imageUrl"
      :label="t('theme.runningSlots.imagePosition')"
    >
      <USelect
        v-model="theme.header.imagePosition"
        :items="headerImagePositionItems"
        class="w-full"
      />
    </UFormField>
    <UFormField
      v-if="theme.header.imageUrl"
      :label="t('theme.runningSlots.imageHeight')"
      :help="`${theme.header.imageHeight}pt`"
    >
      <USlider
        v-model="theme.header.imageHeight"
        :min="6"
        :max="24"
        :step="1"
      />
    </UFormField>
  </div>
</template>
