<script setup lang="ts">
import type { DocTheme } from '~~/shared/types/theme'
import type { BrandKit } from '~/utils/api/types/brandKit'
import { themeImagePreviewSrc, useThemeImageUpload } from '~/composables/document/useThemeImageUpload'

// The cover logo: preview, upload (the document's image flow) or one of
// the workspace's brand images. Empty string = no logo; rendering then
// leaves the <img> out (no broken image).
const props = defineProps<{
  docId: string
  brandImages: BrandKit['images']
}>()
const theme = defineModel<DocTheme>('theme', { required: true })
const { t } = useI18n()

const { inputId: logoInputId, uploading: logoUploading, error: logoError, onFile: onLogoFile } = useThemeImageUpload(() => props.docId, (url) => {
  theme.value.brand.logoUrl = url
})
function clearLogo() {
  theme.value.brand.logoUrl = ''
}
const imagePreviewSrc = (url: string): string => themeImagePreviewSrc(url, props.docId)
</script>

<template>
  <div class="space-y-2">
    <div
      v-if="theme.brand.logoUrl"
      class="flex items-center gap-3 p-2 border border-default rounded"
    >
      <img
        :src="imagePreviewSrc(theme.brand.logoUrl)"
        :alt="t('theme.brand.logoPreview')"
        class="border border-default rounded bg-default"
        :style="{ height: `${theme.brand.logoHeight}px`, maxWidth: '120px', objectFit: 'contain' }"
      >
      <UButton
        color="neutral"
        variant="ghost"
        icon="i-lucide-x"
        size="xs"
        @click="clearLogo"
      >
        {{ t('theme.brand.clearLogo') }}
      </UButton>
    </div>
    <label
      :for="logoInputId"
      class="relative flex rounded-md focus-within:ring-2 focus-within:ring-inverted"
    >
      <input
        :id="logoInputId"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        class="sr-only"
        @change="onLogoFile"
      >
      <UButton
        as="span"
        color="neutral"
        variant="outline"
        icon="i-lucide-upload"
        :loading="logoUploading"
        block
      >
        {{ theme.brand.logoUrl ? t('theme.brand.replaceLogo') : t('theme.brand.uploadLogo') }}
      </UButton>
    </label>
    <p
      v-if="logoError"
      class="text-xs text-error"
    >
      {{ logoError }}
    </p>
    <DocumentThemeBrandImagePicker
      v-if="brandImages.length"
      :images="brandImages"
      :doc-id="docId"
      :selected="theme.brand.logoUrl"
      @select="url => { theme.brand.logoUrl = url }"
    />
  </div>
</template>
