<script setup lang="ts">
/**
 * Preview zoom control. Desktop: a small pill in the preview pane's top
 * right corner — zoom out · current zoom (menu) · zoom in · all pages.
 * `compact` (mobile view-mode bar): one round button opening the same
 * menu, with zoom in / out as menu items.
 */
const props = defineProps<{ compact?: boolean }>()

const { t } = useI18n()
const { zoom, label, items } = usePreviewZoomMenu({ withStepItems: props.compact })
const isOverview = zoom.isOverview
</script>

<template>
  <UDropdownMenu
    v-if="compact"
    :items="items"
    :content="{ align: 'end' }"
  >
    <button
      type="button"
      class="inline-flex items-center justify-center size-8 rounded-full transition-colors"
      :class="isOverview ? 'bg-muted text-default' : 'text-muted hover:text-default'"
      :aria-label="t('previewZoom.menu')"
      data-testid="preview-zoom-mobile"
    >
      <UIcon
        :name="isOverview ? 'i-lucide-layout-grid' : 'i-lucide-zoom-in'"
        class="size-4"
      />
    </button>
  </UDropdownMenu>

  <div
    v-else
    class="inline-flex items-center gap-0.5 rounded-md border border-default bg-default/95 p-0.5 backdrop-blur-sm"
    role="toolbar"
    :aria-label="t('previewZoom.menu')"
    data-testid="preview-zoom-control"
  >
    <UTooltip
      :text="t('previewZoom.zoomOut')"
      :kbds="['meta', '-']"
    >
      <UButton
        icon="i-lucide-minus"
        size="xs"
        color="neutral"
        variant="ghost"
        :aria-label="t('previewZoom.zoomOut')"
        :disabled="isOverview"
        data-testid="preview-zoom-out"
        @click="zoom.zoomOut()"
      />
    </UTooltip>
    <UDropdownMenu
      :items="items"
      :content="{ align: 'end' }"
    >
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        class="min-w-14 justify-center font-mono text-[10.5px] tracking-[0.04em] tabular-nums"
        :aria-label="t('previewZoom.menu')"
        data-testid="preview-zoom-menu"
      >
        {{ label }}
      </UButton>
    </UDropdownMenu>
    <UTooltip
      :text="t('previewZoom.zoomIn')"
      :kbds="['meta', '=']"
    >
      <UButton
        icon="i-lucide-plus"
        size="xs"
        color="neutral"
        variant="ghost"
        :aria-label="t('previewZoom.zoomIn')"
        data-testid="preview-zoom-in"
        @click="zoom.zoomIn()"
      />
    </UTooltip>
    <span
      class="mx-0.5 h-4 w-px bg-[var(--ui-border)]"
      aria-hidden="true"
    />
    <UTooltip :text="isOverview ? t('previewZoom.backToPage') : t('previewZoom.allPages')">
      <UButton
        icon="i-lucide-layout-grid"
        size="xs"
        color="neutral"
        :variant="isOverview ? 'soft' : 'ghost'"
        :aria-label="t('previewZoom.allPages')"
        :aria-pressed="isOverview"
        data-testid="preview-zoom-overview"
        @click="zoom.toggleOverview()"
      />
    </UTooltip>
  </div>
</template>
