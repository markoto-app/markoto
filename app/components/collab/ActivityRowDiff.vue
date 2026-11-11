<script setup lang="ts">
import DiffView from './DiffView.vue'

// Fetches and renders the diff for an expanded edit card. Uses $fetch rather
// than useFetch (mounts once per expansion, no SSR) to control the three
// outcomes: 200 renders the diff, 410 means the diff is unavailable for the
// row, anything else is a generic error with retry. No skeleton: the fetch is
// short, a spinner suffices.

interface DiffLine { kind: 'context' | 'add' | 'remove', text: string }
interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}
interface DiffResponse {
  activityId: number
  before: string
  after: string
  hunks: DiffHunk[]
  truncated: boolean
  totalHunks: number
}

const props = defineProps<{
  docId: string
  activityId: number
}>()

const { t } = useI18n()

const data = ref<DiffResponse | null>(null)
const error = ref<{ kind: 'unavailable' | 'unknown', message?: string } | null>(null)
const loading = ref(true)

async function load() {
  loading.value = true
  error.value = null
  data.value = null
  try {
    data.value = await $fetch<DiffResponse>(
      `/api/docs/${props.docId}/activity/${props.activityId}/diff`
    )
  } catch (e: unknown) {
    const status = (e as { statusCode?: number, status?: number })?.statusCode
      ?? (e as { status?: number })?.status
    if (status === 410) {
      error.value = { kind: 'unavailable' }
    } else {
      const msg = e instanceof Error ? e.message : String(e)
      error.value = { kind: 'unknown', message: msg }
    }
  } finally {
    loading.value = false
  }
}

// The parent mounts this only on expansion, so this fetches on first expand.
onMounted(load)
</script>

<template>
  <div class="activity-row-diff">
    <div
      v-if="loading"
      class="flex items-center justify-center py-3"
    >
      <UIcon
        name="i-lucide-loader"
        class="size-4 animate-spin text-muted"
      />
    </div>

    <div
      v-else-if="error?.kind === 'unavailable'"
      class="text-xs text-muted italic px-2 py-3"
    >
      {{ t('activity.diff.unavailable') }}
    </div>

    <div
      v-else-if="error"
      class="text-xs text-muted px-2 py-3 flex items-center gap-2"
    >
      <UIcon
        name="i-lucide-alert-circle"
        class="size-3.5 text-error"
      />
      <span class="flex-1">{{ t('activity.diff.error') }}</span>
      <button
        type="button"
        class="text-primary hover:underline"
        @click="load"
      >
        {{ t('activity.diff.retry') }}
      </button>
    </div>

    <DiffView
      v-else-if="data"
      :hunks="data.hunks"
      :truncated="data.truncated"
      :total-hunks="data.totalHunks"
    />
  </div>
</template>
