<script setup lang="ts">
import type { Awareness } from 'y-protocols/awareness'

const props = defineProps<{
  awareness: Awareness
}>()

const { t } = useI18n()

interface AwarenessUser {
  name: string
  color: string
  avatar?: string
  isAI?: boolean
}

interface AiSessionMeta {
  sessionId: string
  initiatorName: string
  initiatorUserId: number
  prompt?: string
}

interface AiStatus {
  phase: 'thinking' | 'tool' | 'editing' | 'done' | 'error' | string
  message: string | null
}

interface DisplayEntry {
  clientId: number
  user: AwarenessUser
  isAI: boolean
  aiSession?: AiSessionMeta
  aiStatus?: AiStatus
}

const entries = ref<DisplayEntry[]>([])

function updateEntries() {
  const states = props.awareness.getStates()
  const localId = props.awareness.clientID
  const result: DisplayEntry[] = []

  states.forEach((state, clientId) => {
    if (clientId === localId) return
    if (!state?.user) return
    result.push({
      clientId,
      user: state.user as AwarenessUser,
      isAI: !!state.user.isAI,
      aiSession: state.aiSession as AiSessionMeta | undefined,
      aiStatus: state.aiStatus as AiStatus | undefined
    })
  })

  entries.value = result
}

onMounted(() => {
  updateEntries()
  props.awareness.on('change', updateEntries)
})

onUnmounted(() => {
  props.awareness.off('change', updateEntries)
})

function tooltipFor(e: DisplayEntry): string {
  if (!e.isAI) return e.user.name
  // Keep the tooltip short — the live status is surfaced via the prompt bar placeholder.
  if (e.aiSession?.initiatorName) {
    return t('ai.helpingTooltip', { name: e.aiSession.initiatorName })
  }
  return e.user.name
}

function isActivePhase(status: AiStatus | undefined): boolean {
  if (!status) return false
  return status.phase !== 'done' && status.phase !== 'error'
}
</script>

<template>
  <div v-if="entries.length > 0" class="flex items-center gap-1.5">
    <div class="flex -space-x-1.5">
      <UTooltip
        v-for="e in entries.slice(0, 5)"
        :key="e.clientId"
        :text="tooltipFor(e)"
      >
        <div
          class="relative rounded-full ring-2 shrink-0"
          :class="{
            'ai-pulse': e.isAI && isActivePhase(e.aiStatus)
          }"
          :style="{ '--tw-ring-color': e.user.color }"
        >
          <UAvatar
            v-if="e.user.avatar && !e.isAI"
            :src="e.user.avatar"
            :alt="e.user.name"
            size="xs"
          />
          <div
            v-else
            class="size-6 rounded-full flex items-center justify-center text-[10px] font-semibold text-white"
            :style="{ backgroundColor: e.user.color }"
          >
            <UIcon
              v-if="e.isAI"
              name="i-lucide-sparkles"
              class="size-3.5"
            />
            <span v-else>{{ e.user.name.charAt(0).toUpperCase() }}</span>
          </div>
        </div>
      </UTooltip>
    </div>
    <span v-if="entries.length > 5" class="text-xs text-muted">
      +{{ entries.length - 5 }}
    </span>
  </div>
</template>

<style scoped>
/* Gentle pulse to signal an active AI session */
.ai-pulse {
  animation: ai-ring-pulse 1.6s ease-in-out infinite;
}
@keyframes ai-ring-pulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--tw-ring-color); }
  50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--tw-ring-color) 30%, transparent); }
}
</style>
