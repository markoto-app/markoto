<script setup lang="ts">
// Mobile view-mode toggle: floats top-right of the content area (the bottom
// holds the AI response panel, prompt bar and tab bar). Edit and preview
// only (no useful 50/50 at 390px), plus the preview zoom while previewing.
const viewMode = defineModel<'edit' | 'preview' | 'split'>({ required: true })
const { t } = useI18n()
</script>

<template>
  <div
    class="sm:hidden absolute top-3 right-3 z-30 inline-flex items-center gap-0.5 rounded-full border border-default bg-default shadow-md p-0.5"
    data-testid="mobile-viewmode-bar"
  >
    <button
      type="button"
      class="inline-flex items-center justify-center size-8 rounded-full transition-colors"
      :class="viewMode === 'edit' ? 'bg-muted text-default' : 'text-muted hover:text-default'"
      :aria-label="t('editor.edit')"
      :aria-pressed="viewMode === 'edit'"
      @click="viewMode = 'edit'"
    >
      <UIcon
        name="i-lucide-pen"
        class="size-4"
      />
    </button>
    <button
      type="button"
      class="inline-flex items-center justify-center size-8 rounded-full transition-colors"
      :class="viewMode === 'preview' ? 'bg-muted text-default' : 'text-muted hover:text-default'"
      :aria-label="t('editor.preview')"
      :aria-pressed="viewMode === 'preview'"
      @click="viewMode = 'preview'"
    >
      <UIcon
        name="i-lucide-eye"
        class="size-4"
      />
    </button>
    <!-- Preview zoom (fit width / all pages / fixed steps); pinch on the preview zooms too. -->
    <template v-if="viewMode === 'preview'">
      <span
        class="mx-0.5 h-4 w-px bg-[var(--ui-border)]"
        aria-hidden="true"
      />
      <PreviewZoomControl compact />
    </template>
  </div>
</template>
