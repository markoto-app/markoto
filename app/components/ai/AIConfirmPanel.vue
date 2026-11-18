<script setup lang="ts">
import type { AiConfirmationRequest } from '~/composables/ai/useAI'
import { CONFIRM_NOTE_MAX_LENGTH } from '~~/shared/api/ai'

// Inline "Allow / Deny" card above the prompt bar. Shown to the person
// who started the AI session, and only to them (the request arrives
// through their private session channel, never through awareness),
// when the AI wants to reach beyond a document that contains other
// people's text: read another document, list documents, search or read
// workspace knowledge, create / copy a document, search the web or open
// a URL nobody typed. No answer within the server's timeout = deny.
// With Deny the user may type a short note ("No, search for X instead");
// the AI reads it as their instruction.
//
// Voice: the question is markoto speaking, so it wears the AI italic
// (Fraunces); the target (title, query, URL) is set in mono so the user
// sees exactly what will be read or sent. Buttons are neutral, shu
// marks the AI, not a call to action.

const props = defineProps<{
  request: AiConfirmationRequest | null
  busy: boolean
}>()

const emit = defineEmits<{
  (e: 'allow'): void
  (e: 'deny', note?: string): void
}>()

const note = ref('')
// A new request starts with an empty note.
watch(() => props.request?.id, () => {
  note.value = ''
})

function deny(): void {
  const text = note.value.trim()
  emit('deny', text.length > 0 ? text : undefined)
}

const { t, te } = useI18n()

const isJob = computed(() => props.request?.kind === 'job' && !!props.request.job)

function money(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`
}

/** "Translate 152 sections to English: about $0.11 (22 % of this month's allowance), about 5 minutes." */
const jobQuestion = computed(() => {
  const job = props.request?.job
  if (!job) return ''
  const what = job.mode === 'translate' && job.targetLanguage
    ? t('ai.confirm.job.modes.translateTo', { count: job.units, language: job.targetLanguage })
    : t(`ai.confirm.job.modes.${job.mode}`, { count: job.units })
  const cost = job.usd === null
    ? t('ai.confirm.job.tokens', { tokens: (job.inputTokens + job.outputTokens).toLocaleString() })
    : job.allowanceShare === null
      ? t('ai.confirm.job.cost', { cost: money(job.usd) })
      : t('ai.confirm.job.costShare', { cost: money(job.usd), share: `${Math.max(1, Math.round(job.allowanceShare * 100))} %` })
  const minutes = t('ai.confirm.job.minutes', { minutes: Math.max(1, Math.round(job.minutes)) })
  return t('ai.confirm.job.question', { what, cost, minutes })
})

const question = computed(() => {
  const r = props.request
  if (!r) return ''
  if (isJob.value) return jobQuestion.value
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
      :data-kind="isJob ? 'job' : 'tool'"
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
              {{ isJob ? t('ai.confirm.job.reason') : t('ai.confirm.reason') }}
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
            @click="deny"
          >
            {{ isJob ? t('ai.confirm.job.cancel') : t('ai.confirm.deny') }}
          </UButton>
          <UButton
            color="neutral"
            size="sm"
            :loading="busy"
            data-testid="ai-confirm-allow"
            @click="emit('allow')"
          >
            {{ isJob ? t('ai.confirm.job.start') : t('ai.confirm.allow') }}
          </UButton>
        </div>
      </div>
      <UInput
        v-model="note"
        class="mt-2 w-full"
        size="sm"
        :maxlength="CONFIRM_NOTE_MAX_LENGTH"
        :disabled="busy"
        :placeholder="t('ai.confirm.notePlaceholder')"
        :aria-label="t('ai.confirm.noteLabel')"
        data-testid="ai-confirm-note"
        @keydown.enter.prevent="note.trim() && deny()"
      />
    </section>
  </Transition>
</template>

<style scoped>
.ai-confirm-panel {
  border-color: var(--color-shu-500);
}
html.dark .ai-confirm-panel {
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
