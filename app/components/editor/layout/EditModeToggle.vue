<script setup lang="ts">
// Editing / Suggesting switch of the top bar. In suggesting mode your
// changes are proposals others accept or reject (suggestions panel). When
// the document requires suggestions of you, or you may only suggest
// (a viewer allowed to), the switch is fixed on Suggesting and says why.
const props = defineProps<{
  /** Suggesting is the only mode this person has. */
  forced: boolean
  /** The owner requires suggestions (the reason when forced). */
  required: boolean
}>()
const suggesting = defineModel<boolean>({ required: true })
const { t } = useI18n()

const on = computed(() => props.forced || suggesting.value)
const label = computed(() => on.value ? t('suggestions.mode.suggesting') : t('suggestions.mode.editing'))
const hint = computed(() => {
  if (props.forced) return props.required ? t('suggestions.mode.requiredHint') : t('suggestions.mode.viewerHint')
  return on.value ? t('suggestions.mode.suggestingHint') : t('suggestions.mode.editingHint')
})

function toggle() {
  if (!props.forced) suggesting.value = !suggesting.value
}
</script>

<template>
  <UTooltip :text="hint">
    <UButton
      :icon="on ? 'i-lucide-file-diff' : 'i-lucide-pencil'"
      color="neutral"
      :variant="on ? 'soft' : 'ghost'"
      size="xs"
      :aria-label="`${label}. ${hint}`"
      :aria-pressed="on"
      :aria-disabled="forced"
      :data-mode="on ? 'suggesting' : 'editing'"
      data-testid="edit-mode-toggle"
      @click="toggle"
    >
      <span class="hidden md:inline">{{ label }}</span>
    </UButton>
  </UTooltip>
</template>
