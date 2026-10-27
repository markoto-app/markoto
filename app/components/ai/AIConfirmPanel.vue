<script setup lang="ts">
import type { AiConfirmationRequest } from '~/composables/useAI'

// Inline "Allow / Deny" card above the prompt bar. Shown to the person
// who started the AI session — and only to them (the request arrives
// through their private session channel, never through awareness) —
// when the AI wants to reach beyond a document that contains other
// people's text: read another document, list documents, search or read
// workspace knowledge, create / copy a document, search the web or open
// a URL nobody typed. No answer within the server's timeout = deny.
//
// Voice: the question is markoto speaking, so it wears the AI italic
// (Fraunces); the target (title, query, URL) is set in mono so the user
// sees exactly what will be read or sent. Buttons are neutral — shu
// marks the AI, not a call to action.

const props = defineProps<{
  request: AiConfirmationRequest | null
  busy: boolean
}>()

const emit = defineEmits<{
  (e: 'allow' | 'deny'): void
}>()

const { t, te } = useI18n()

const question = computed(() => {
  const r = props.request
  if (!r) return ''
  const key = `ai.confirm.tools.${r.tool}`
  if (te(key)) return t(key, { target: r.target ?? '' })
  return t('ai.confirm.tools.generic', { tool: r.tool })
})
</script>

<template>
  <Transition name="confirm-panel">
    <section
      v-if="request"
      class="ai-confirm-panel pointer-events-auto mb-2 block w-full max-w-3xl rounded-2xl border bg-default px-4 py-3"
      role="alertdialog"
      aria-live="assertive"
      :aria-label="t('ai.confirm.label')"
      data-testid="ai-confirm-panel"
      :data-tool="request.tool"
    >
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div class="flex min-w-0 flex-1 items-start gap-3">
          <CommonSeal
            :size="10"
            class="mt-1.5 shrink-0"
          />
          <div class="min-w-0 flex-1">
            <div class="mb-1 font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">
              {{ t('ai.confirm.label') }}
            </div>
            <p
              class="break-words font-serif text-[15px] italic tracking-[-0.01em] text-default"
              data-testid="ai-confirm-question"
            >
              {{ question }}
            </p>
            <p class="mt-1 text-xs text-muted">
              {{ t('ai.confirm.reason') }}
            </p>
          </div>
        </div>
        <div class="flex shrink-0 items-center justify-end gap-1.5">
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            :disabled="busy"
            data-testid="ai-confirm-deny"
            @click="emit('deny')"
          >
            {{ t('ai.confirm.deny') }}
          </UButton>
          <UButton
            color="neutral"
            size="sm"
            :loading="busy"
            data-testid="ai-confirm-allow"
            @click="emit('allow')"
          >
            {{ t('ai.confirm.allow') }}
          </UButton>
        </div>
      </div>
    </section>
  </Transition>
</template>

<style scoped>
.ai-confirm-panel {
  border-color: var(--color-shu-500);
}
:global(.dark) .ai-confirm-panel {
  border-color: var(--color-shu-400);
}

.confirm-panel-enter-active,
.confirm-panel-leave-active {
  transition: opacity 180ms cubic-bezier(0.4, 0, 0.2, 1), transform 180ms cubic-bezier(0.4, 0, 0.2, 1);
}
.confirm-panel-enter-from,
.confirm-panel-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
@media (prefers-reduced-motion: reduce) {
  .confirm-panel-enter-active,
  .confirm-panel-leave-active {
    transition: none;
  }
}
</style>
