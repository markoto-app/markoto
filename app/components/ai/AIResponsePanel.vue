<script setup lang="ts">
import type { AiResponseEntry } from '~/composables/useAI'

// The AI's ephemeral response surface — sits directly above the prompt
// bar. Driven by `lastResponse` from `useAI`, which latches the most
// recent `message_to_user` call so the panel survives the AI session
// ending (~2.5s after `done`). Phase 1 of the response substrate; the
// panel is purely a viewport with no history list — chat-thread shape
// is deliberately avoided (the doc IS the artefact).
//
// Two modes:
//   - Plain message (`isQuestion: false`) — auto-collapses 2s after the
//     timestamp; the user can re-expand via the "last response" pill.
//   - Question (`isQuestion: true`) — sticky until the user dismisses
//     or sends a follow-up prompt.
//
// All copy is i18n-keyed under `ai.response*`.

const props = defineProps<{
  response: AiResponseEntry | null
}>()

// Emitted whenever the expanded state flips (auto-collapse, hover
// pause/resume, manual expand from the pill). The parent uses this to
// mirror the wrapper-class state (`.has-response`) so the merged shell
// styling stays in lockstep with what the panel is actually showing.
// Without this, a separate wrapper-side timer would unmerge the shell
// while the panel is still hovered and visible.
const emit = defineEmits<{
  (e: 'update:expanded', value: boolean): void
}>()

const { t } = useI18n()

const COLLAPSE_AFTER_MS = 10_000

// Local UI state — `expanded` flips to false `COLLAPSE_AFTER_MS` after
// the response APPEARS to the user (not after the server stamped it).
// The previous implementation measured from the server-stamped `ts`,
// which silently shortened the window any time the awareness round-trip
// + Vue reactivity took non-trivial time and could collapse the panel
// almost instantly on a busy AI loop. Now: every fresh `ts` resets to
// the full window from this moment, regardless of how old the server
// timestamp is. Hovering pauses the timer so longer messages can be
// read at the user's pace.
//
// `manuallyExpanded`: distinguishes the auto-show path (fresh response
// arrives) from the user-triggered path (clicking the "Last response"
// pill to re-open a previously collapsed message). Auto-show schedules
// the collapse timer; manual re-open does NOT — the user has explicitly
// asked to read it, so we wait for them to click × to collapse again.
// Reset to false on every fresh `ts` (a new response is considered an
// auto-show even if it arrives while the user has the pill open).
const expanded = ref(true)
const isHovered = ref(false)
const manuallyExpanded = ref(false)
// Mirror every expanded change to the parent so the wrapper class
// (`.has-response` on AIPromptBar) tracks the panel's actual state.
watch(expanded, v => emit('update:expanded', v), { immediate: true })
let collapseTimer: ReturnType<typeof setTimeout> | null = null

function clearCollapseTimer() {
  if (collapseTimer) {
    clearTimeout(collapseTimer)
    collapseTimer = null
  }
}

function scheduleCollapse() {
  clearCollapseTimer()
  if (!props.response || props.response.isQuestion || isHovered.value) return
  // Manual re-opens (user clicked the pill) opt out of auto-collapse —
  // they've made the deliberate choice to read it; we don't want to
  // hide it again 10s later.
  if (manuallyExpanded.value) return
  collapseTimer = setTimeout(() => { expanded.value = false }, COLLAPSE_AFTER_MS)
}

watch(
  () => props.response?.ts ?? null,
  () => {
    clearCollapseTimer()
    if (!props.response) {
      expanded.value = false
      manuallyExpanded.value = false
      return
    }
    // Fresh response arrival is an auto-show — clear any previous
    // manual-open state so the timer fires for the new message.
    manuallyExpanded.value = false
    expanded.value = true
    scheduleCollapse()
  },
  { immediate: true }
)

onBeforeUnmount(clearCollapseTimer)

function expand() {
  // Pill click → manual re-open. Stays open until × is clicked;
  // scheduleCollapse() short-circuits when manuallyExpanded is true.
  manuallyExpanded.value = true
  expanded.value = true
}

// Closing the expanded card collapses to the "Last response" pill —
// it does NOT evict the latched response. The user can re-expand by
// clicking the pill. The latched response is only cleared when a
// fresh `message_to_user` arrives in the same / a new session.
// The pre-fix behaviour (× = evict) hid the response forever with no
// way to bring it back, which broke the spec.
function dismiss() {
  clearCollapseTimer()
  // Reset manual flag so the next expand goes through the manual
  // path cleanly (otherwise a stale `true` here would prevent the
  // auto-collapse timer from running on a hypothetical future
  // re-arming path).
  manuallyExpanded.value = false
  expanded.value = false
}

function onPointerEnter() {
  isHovered.value = true
  clearCollapseTimer()
}

function onPointerLeave() {
  isHovered.value = false
  // Resume the timer from this moment so the user gets the full
  // window after they move away. No-ops in question / manual modes.
  scheduleCollapse()
}
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
