<script setup lang="ts">
import { useAiSuggestSwitch } from '~/composables/editor/useEditorSuggestions'

// The prompt bar's "AI suggests changes" switch: the AI's edits arrive as
// suggestions to accept or reject. Fixed on where the document requires
// suggestions of this person (the server enforces it either way). State
// from the editor (`useEditorSuggestions`); absent outside it.
const state = useAiSuggestSwitch()
const { t } = useI18n()

const on = computed(() => state?.forced.value || state?.aiSuggest.value || false)
const hint = computed(() => {
  if (state?.forced.value) return t('suggestions.ai.forced')
  return on.value ? t('suggestions.ai.on') : t('suggestions.ai.off')
})

function toggle() {
  if (state && !state.forced.value) state.aiSuggest.value = !state.aiSuggest.value
}
</script>

<template>
  <UTooltip
    v-if="state"
    :text="hint"
  >
    <UButton
      icon="i-lucide-file-diff"
      color="neutral"
      :variant="on ? 'soft' : 'ghost'"
      size="sm"
      :aria-label="t('suggestions.ai.toggle')"
      :aria-pressed="on"
      :aria-disabled="state.forced.value"
      data-testid="ai-prompt-bar-suggest"
      @click="toggle"
    />
  </UTooltip>
</template>
