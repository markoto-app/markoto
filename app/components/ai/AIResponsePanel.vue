<script setup lang="ts">
import { toRef, watch } from 'vue'
import type { AiResponseEntry } from '~/composables/ai/useAI'
import { useResponsePanelState } from './useResponsePanelState'

// The AI's ephemeral response surface, directly above the prompt bar.
// Driven by `lastResponse` from `useAI`, which latches the most recent
// `message_to_user` so the panel survives the AI session ending (~2.5s
// after `done`). It is a viewport with no history list: the doc IS the
// artefact, not a chat thread.
//
// Two modes:
//   - Plain message (`isQuestion: false`): auto-collapses 10s after
//     arrival; the user can re-expand via the "last response" pill.
//   - Question (`isQuestion: true`): sticky until the user dismisses
//     or sends a follow-up prompt.
//
// The timer + manual-expand state machine lives in
// `useResponsePanelState.ts` so it can be unit-tested without mounting
// the SFC (the `dom` test project has no `@vitejs/plugin-vue`, and the
// `nuxt` project trips a transform-time SVG block at boot).

const props = defineProps<{
  response: AiResponseEntry | null
}>()

// Emitted whenever the expanded state flips (auto-collapse, hover
// pause/resume, manual expand from the pill). The parent uses this to
// mirror the wrapper-class state (`.has-response`) so the merged shell
// styling stays in lockstep with what the panel is actually showing.
const emit = defineEmits<{
  (e: 'update:expanded', value: boolean): void
}>()

const { t } = useI18n()

// `useResponsePanelState` consumes the response as a Ref<...> so the
// `watch(() => source.value?.ts ...)` sees prop updates reactively.
const responseRef = toRef(props, 'response')
const { expanded, expand, dismiss, onPointerEnter, onPointerLeave } = useResponsePanelState({
  source: responseRef,
  isQuestion: r => r.isQuestion === true
})

watch(expanded, v => emit('update:expanded', v), { immediate: true })
</script>

<template>
  <Transition name="response-panel">
    <output
      v-if="response && expanded"
      class="ai-response-panel pointer-events-auto block w-full max-w-3xl rounded-2xl border border-default bg-default px-4 py-3 shadow-sm"
      :class="{ 'is-question': response.isQuestion }"
      :aria-live="response.isQuestion ? 'assertive' : 'polite'"
      data-testid="ai-response-panel"
      @pointerenter="onPointerEnter"
      @pointerleave="onPointerLeave"
    >
      <div class="flex items-start gap-3">
        <CommonSeal
          :size="10"
          class="mt-1 shrink-0"
        />
        <div class="flex-1 min-w-0">
          <div class="font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted mb-1">
            {{ response.isQuestion ? t('ai.responseQuestionLabel') : t('ai.responseLabel') }}
          </div>
          <p class="text-sm text-default whitespace-pre-wrap break-words">
            {{ response.message }}
          </p>
        </div>
        <button
          type="button"
          class="shrink-0 rounded-full p-1 text-muted hover:text-default hover:bg-elevated transition-colors"
          :aria-label="t('ai.responseDismiss')"
          :title="t('ai.responseDismiss')"
          @click="dismiss"
        >
          <UIcon
            name="i-lucide-x"
            class="size-4"
          />
        </button>
      </div>
    </output>
    <button
      v-else-if="response && !expanded"
      type="button"
      class="ai-response-pill pointer-events-auto inline-flex items-center gap-2 rounded-full border border-default bg-default px-3 py-1.5 shadow-sm hover:bg-elevated transition-colors"
      :aria-label="t('ai.responseShowLast')"
      :title="t('ai.responseShowLast')"
      data-testid="ai-response-pill"
      @click="expand"
    >
      <CommonSeal :size="8" />
      <span class="font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">
        {{ t('ai.responseShowLast') }}
      </span>
    </button>
  </Transition>
</template>

<style scoped>
.ai-response-panel.is-question {
  border-color: var(--color-shu-500);
}

/*
 * Matches the prompt-bar shell's `border-radius` transition (220ms, same
 * easing) so the panel's slide-up and the bar's top-corner flatten run
 * in lockstep, reading as one motion. translateY(10px) starts the panel
 * slightly over the bar's top edge, so it rises out of the bar.
 */
.response-panel-enter-active,
.response-panel-leave-active {
  transition:
    opacity 220ms cubic-bezier(0.4, 0, 0.2, 1),
    transform 220ms cubic-bezier(0.4, 0, 0.2, 1);
}

.response-panel-enter-from,
.response-panel-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
</style>
