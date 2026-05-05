<script setup lang="ts">
import { toRef, watch } from 'vue'
import type { AiResponseEntry } from '~/composables/useAI'
import { useResponsePanelState } from './useResponsePanelState'

// The AI's ephemeral response surface — sits directly above the prompt
// bar. Driven by `lastResponse` from `useAI`, which latches the most
// recent `message_to_user` call so the panel survives the AI session
// ending (~2.5s after `done`). Phase 1 of the response substrate; the
// panel is purely a viewport with no history list — chat-thread shape
// is deliberately avoided (the doc IS the artefact).
//
// Two modes:
//   - Plain message (`isQuestion: false`) — auto-collapses 10s after
//     arrival; the user can re-expand via the "last response" pill.
//   - Question (`isQuestion: true`) — sticky until the user dismisses
//     or sends a follow-up prompt.
//
// All copy is i18n-keyed under `ai.response*`.
//
// The timer + manual-expand state machine lives in
// `useResponsePanelState.ts` so it can be unit-tested without
// mounting the SFC (the test infra's `dom` project doesn't ship
// `@vitejs/plugin-vue`, and the `nuxt` project trips a transform-time
// SVG block at boot). The component just wires props → state → DOM.

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
// (timer / state-machine logic lives in useResponsePanelState.ts)
</script>

<template>
  <Transition name="response-panel">
    <div
      v-if="response && expanded"
      class="ai-response-panel pointer-events-auto w-full max-w-3xl rounded-2xl border border-default bg-default px-4 py-3 shadow-sm"
      :class="{ 'is-question': response.isQuestion }"
      role="status"
      :aria-live="response.isQuestion ? 'assertive' : 'polite'"
      data-testid="ai-response-panel"
      @pointerenter="onPointerEnter"
      @pointerleave="onPointerLeave"
    >
      <div class="flex items-start gap-3">
        <CommonSeal :size="10" class="mt-1 shrink-0" />
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
          <UIcon name="i-lucide-x" class="size-4" />
        </button>
      </div>
    </div>
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
 * Match the prompt-bar shell's `border-radius` transition (220ms with
 * the same easing curve) so the panel's slide-up + the bar's top-corner
 * flatten happen in lockstep — the eye perceives one continuous motion
 * instead of two separately-timed ones. translateY(10px) starts the
 * panel slightly OVER the bar's top edge before settling above it,
 * giving a "rising out of the bar" feel rather than "fading in from
 * thin air".
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
