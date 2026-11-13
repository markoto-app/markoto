<script setup lang="ts">
// Desktop view-mode group (edit / split / preview), centred in the top bar.
const viewMode = defineModel<'edit' | 'preview' | 'split'>({ required: true })
const { t } = useI18n()
</script>

<template>
  <div class="hidden sm:flex shrink-0 items-center justify-center">
    <UTooltip :text="t('editor.edit')">
      <UButton
        icon="i-lucide-code-2"
        size="xs"
        :color="viewMode === 'edit' ? 'primary' : 'neutral'"
        :variant="viewMode === 'edit' ? 'solid' : 'ghost'"
        :aria-label="t('editor.edit')"
        :aria-pressed="viewMode === 'edit'"
        data-testid="view-mode-edit"
        @click="viewMode = 'edit'"
      />
    </UTooltip>
    <UTooltip :text="t('editor.splitView')">
      <UButton
        icon="i-lucide-columns-2"
        size="xs"
        :color="viewMode === 'split' ? 'primary' : 'neutral'"
        :variant="viewMode === 'split' ? 'solid' : 'ghost'"
        :aria-label="t('editor.splitView')"
        :aria-pressed="viewMode === 'split'"
        data-testid="view-mode-split"
        @click="viewMode = 'split'"
      />
    </UTooltip>
    <UTooltip :text="t('editor.preview')">
      <UButton
        icon="i-lucide-eye"
        size="xs"
        :color="viewMode === 'preview' ? 'primary' : 'neutral'"
        :variant="viewMode === 'preview' ? 'solid' : 'ghost'"
        :aria-label="t('editor.preview')"
        :aria-pressed="viewMode === 'preview'"
        data-testid="view-mode-preview"
        @click="viewMode = 'preview'"
      />
    </UTooltip>
  </div>
</template>
