<script setup lang="ts">
import type { AiSessionInfo } from '../../composables/useAI'

const props = defineProps<{
  ai: {
    mySession: ReturnType<typeof useAI>['mySession']
    mySessionId: ReturnType<typeof useAI>['mySessionId']
    otherSessions: ReturnType<typeof useAI>['otherSessions']
    submitting: ReturnType<typeof useAI>['submitting']
    lastError: ReturnType<typeof useAI>['lastError']
    prompt: ReturnType<typeof useAI>['prompt']
    abort: ReturnType<typeof useAI>['abort']
    clearLastError: ReturnType<typeof useAI>['clearLastError']
  }
}>()

const { t } = useI18n()
const { loggedIn } = useUserSession()
const toast = useToast()

const input = ref('')

const placeholder = computed(() => {
  if (!loggedIn.value) return t('ai.loginRequired')
  if (props.ai.mySession.value) return props.ai.mySession.value.message || t('ai.statusThinking')
  return t('ai.placeholder')
})

const disabled = computed(() => {
  return !loggedIn.value || !!props.ai.mySessionId.value || props.ai.submitting.value
})

async function onSubmit() {
  const text = input.value.trim()
  if (!text || disabled.value) return
  const ok = await props.ai.prompt(text)
  if (ok) input.value = ''
  // Errors — whether from submission or from a mid-session failure — are surfaced via
  // the `lastError` watcher below so we don't duplicate the toast here.
}

// Any time `lastError` changes to a non-empty string, show a toast and ask the
// composable to clear it so the next error fires its own toast. `lastError` is
// exposed readonly — we never mutate it directly from the component.
watch(() => props.ai.lastError.value, (err) => {
  if (!err) return
  toast.add({
    title: t('ai.failed'),
    description: err,
    icon: 'i-lucide-alert-circle',
    color: 'error'
  })
  props.ai.clearLastError()
})

async function onStop() {
  await props.ai.abort()
}

// Phase-to-icon mapping for the active-session status icon
const statusIcon = computed(() => {
  const phase = props.ai.mySession.value?.phase
  switch (phase) {
    case 'thinking': return 'i-lucide-brain'
    case 'tool': return 'i-lucide-wrench'
    case 'editing': return 'i-lucide-pencil'
    case 'error': return 'i-lucide-alert-circle'
    case 'done': return 'i-lucide-check-circle'
    default: return 'i-lucide-sparkles'
  }
})
</script>

<template>
  <div class="border-b border-default px-2 py-1.5 shrink-0 flex items-center gap-2">
    <!-- Sparkles icon / live status icon -->
    <UIcon
      :name="ai.mySession.value ? statusIcon : 'i-lucide-sparkles'"
      :class="[
        'size-4 shrink-0',
        ai.mySession.value ? 'text-amber-500 animate-pulse' : 'text-amber-500'
      ]"
    />

    <!-- Prompt input -->
    <input
      v-model="input"
      type="text"
      :placeholder="placeholder"
      :disabled="disabled"
      class="flex-1 bg-transparent outline-none text-sm placeholder:text-muted disabled:text-muted"
      :class="{ 'italic': disabled && !!ai.mySession.value }"
      @keydown.enter="onSubmit"
    >

    <!-- Other-sessions indicator (non-mine) -->
    <UTooltip
      v-if="ai.otherSessions.value.length > 0"
      :text="ai.otherSessions.value.map(s => `${s.initiatorName}: ${s.prompt}`).join('\n')"
    >
      <UBadge color="warning" variant="subtle" size="sm">
        <UIcon name="i-lucide-users" class="size-3 mr-1" />
        {{ t('ai.otherSessions', ai.otherSessions.value.length) }}
      </UBadge>
    </UTooltip>

    <!-- Send / Stop button -->
    <UButton
      v-if="!ai.mySession.value"
      size="xs"
      color="primary"
      icon="i-lucide-send"
      :loading="ai.submitting.value"
      :disabled="!loggedIn || !input.trim()"
      @click="onSubmit"
    >
      {{ t('ai.send') }}
    </UButton>
    <UButton
      v-else
      size="xs"
      color="error"
      icon="i-lucide-square"
      @click="onStop"
    >
      {{ t('ai.stop') }}
    </UButton>
  </div>
</template>
