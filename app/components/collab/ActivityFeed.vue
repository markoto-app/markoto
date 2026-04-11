<script setup lang="ts">
const props = defineProps<{
  docId: string
}>()

const { t } = useI18n()

interface ActivityEntry {
  id: number
  docId: string
  userName: string | null
  action: 'edit' | 'join' | 'leave'
  wordCount: number | null
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

// Auto-refresh every 30 seconds while the sidebar is visible
const { pause, resume } = useIntervalFn(loadActivity, 30_000)

onUnmounted(() => {
  pause()
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
    <div v-if="loading" class="flex justify-center py-4">
      <UIcon name="i-lucide-loader" class="size-5 animate-spin text-muted" />
    </div>
    <div v-else-if="entries.length === 0" class="text-sm text-muted text-center py-4">
      {{ t('activity.noActivity') }}
    </div>
    <div
      v-for="entry in entries"
      :key="entry.id"
      class="flex items-start gap-2 py-1.5 px-2 rounded text-sm"
    >
      <UIcon
        :name="actionIcons[entry.action] || 'i-lucide-activity'"
        class="size-4 mt-0.5 text-muted shrink-0"
      />
      <div class="min-w-0 flex-1">
        <span class="font-medium">{{ entry.userName || t('activity.anonymous') }}</span>
        <span class="text-muted"> {{ t(`activity.action.${entry.action}`) }}</span>
      </div>
      <span class="text-xs text-muted shrink-0">{{ formatTime(entry.createdAt) }}</span>
    </div>
  </div>
</template>
