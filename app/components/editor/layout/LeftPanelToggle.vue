<script setup lang="ts">
// Opens and closes the editor's left panel (outline, workspace documents),
// at the left end of the toolbar row, above the column it opens. Desktop
// only: on a phone the panel is in the menu.
defineProps<{ open: boolean }>()
const emit = defineEmits<{ toggle: [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="hidden sm:flex items-center pl-2 pr-1 py-1 shrink-0">
    <UTooltip
      :text="open ? t('leftPanel.hide') : t('leftPanel.show')"
      :kbds="['meta', 'shift', 'e']"
    >
      <UButton
        :icon="open ? 'i-lucide-panel-left-close' : 'i-lucide-panel-left-open'"
        color="neutral"
        :variant="open ? 'soft' : 'ghost'"
        size="xs"
        :aria-label="open ? t('leftPanel.hide') : t('leftPanel.show')"
        :aria-pressed="open"
        aria-keyshortcuts="Control+Shift+E Meta+Shift+E"
        data-testid="left-panel-toggle"
        @click="emit('toggle')"
      />
    </UTooltip>
  </div>
</template>
