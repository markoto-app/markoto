<script setup lang="ts">
// The workspace's brand-kit logos (WP10) as one-click choices in the theme
// panel's logo and header-image fields. Shown only inside a workspace
// that has some. Picking one stores `/api/brand/<file>` in the theme.

defineProps<{
  images: ReadonlyArray<{ url: string, name: string, file: string }>
  docId: string
  selected: string
}>()
const emit = defineEmits<{ select: [url: string] }>()
const { t } = useI18n()
</script>

<template>
  <div
    class="space-y-1"
    data-testid="theme-brand-images"
  >
    <p class="font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">
      {{ t('brandKit.workspaceLogos') }}
    </p>
    <div class="flex flex-wrap gap-2">
      <button
        v-for="img in images"
        :key="img.file"
        type="button"
        class="h-10 px-2 rounded border bg-default flex items-center"
        :class="selected === img.url ? 'border-inverted' : 'border-default hover:border-muted'"
        :title="img.name"
        :aria-label="img.name"
        :aria-pressed="selected === img.url"
        :data-testid="`theme-brand-image-${img.file}`"
        @click="emit('select', img.url)"
      >
        <img
          :src="`/api/docs/${docId}/brand/${img.file}`"
          :alt="img.name"
          class="max-h-7 max-w-24 object-contain"
        >
      </button>
    </div>
  </div>
</template>
