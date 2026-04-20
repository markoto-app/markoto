<script setup lang="ts">
import type * as Y from 'yjs'

const props = defineProps<{
  docId: string
  ydoc?: Y.Doc | null
}>()

const { t } = useI18n()

interface ActivityEntry {
  id: number
  docId: string
  userName: string | null
  action: 'edit' | 'join' | 'leave'
  wordCount: number | null
  linesAdded: number | null
  linesRemoved: number | null
  createdAt: string | number
}

const entries = ref<ActivityEntry[]>([])
const loading = ref(true)

async function loadActivity() {
  try {
    entries.value = await $fetch<ActivityEntry[]>(`/api/docs/${props.docId}/activity`)
  } catch {
    entries.value = []
  } finally {
    loading.value = false
  }
}

onMounted(loadActivity)

// Safety-net poll — covers join/leave entries and recovers from missed updates.
// The main trigger is the Y.js update listener below, which gives us near-live
// refreshes whenever anyone (human or the AI assistant) edits the document.
const { pause } = useIntervalFn(loadActivity, 30_000)

// Sync-server debounces `onStoreDocument` (and therefore activity logging) at
// 2-10 s after the last change. Refetch ~3 s after the doc stops changing so
// the feed catches the new entry without hammering the API on every keystroke.
const debouncedReload = useDebounceFn(loadActivity, 3_000)
function onYUpdate() {
  debouncedReload()
}

watch(() => props.ydoc, (doc, prev) => {
  prev?.off('update', onYUpdate)
  doc?.on('update', onYUpdate)
}, { immediate: true })

onUnmounted(() => {
  pause()
  props.ydoc?.off('update', onYUpdate)
})

const actionIcons: Record<string, string> = {
  edit: 'i-lucide-pencil',
  join: 'i-lucide-log-in',
  leave: 'i-lucide-log-out'
}

function formatTime(ts: string | number) {
  const date = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return t('activity.justNow')
  if (mins < 60) return t('activity.minutesAgo', { count: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('activity.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  return t('activity.daysAgo', { count: days })
}
</script>

<template>
  <div class="space-y-1">
    <div
      v-if="loading"
      class="flex justify-center py-4"
    >
      <UIcon
        name="i-lucide-loader"
        class="size-5 animate-spin text-muted"
      />
    </div>
    <div
      v-else-if="entries.length === 0"
      class="text-sm text-muted text-center py-4"
    >
      {{ t('activity.noActivity') }}
    </div>
    <div
      v-for="entry in entries"
      :key="entry.id"
      class="flex items-start gap-2 py-2 px-2 rounded text-sm"
    >
      <UIcon
        v-if="entry.userName === 'AI Assistant'"
        name="i-lucide-sparkles"
        class="size-4 mt-0.5 text-amber-500 shrink-0"
      />
      <UIcon
        v-else
        :name="actionIcons[entry.action] || 'i-lucide-activity'"
        class="size-4 mt-0.5 text-muted shrink-0"
      />
      <div class="min-w-0 flex-1 leading-snug">
        <span class="font-medium">{{ entry.userName || t('activity.anonymous') }}</span>
        <span class="text-muted ml-1">{{ t(`activity.action.${entry.action}`) }}</span>
        <!-- Git-style diff badges (edits only, when we have numbers). -->
        <span
          v-if="entry.action === 'edit' && (entry.linesAdded || entry.linesRemoved)"
          class="ml-1.5 inline-flex items-center gap-1 text-xs font-mono"
        >
          <span
            v-if="entry.linesAdded"
            class="text-green-500"
          >+{{ entry.linesAdded }}</span>
          <span
            v-if="entry.linesRemoved"
            class="text-red-500"
          >-{{ entry.linesRemoved }}</span>
        </span>
        <div class="text-xs text-muted mt-0.5">
          {{ formatTime(entry.createdAt) }}
        </div>
      </div>
    </div>
  </div>
</template>
