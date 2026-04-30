<script setup lang="ts">
import DiffView from './DiffView.vue'

// Lazy fetcher that wraps DiffView. ActivityFeed embeds this inside
// each expanded edit card. We use $fetch (not useFetch) because:
//   - The component mounts once per expansion; no SSR involved.
//   - We want manual control over loading / error / unavailable
//     states for the three distinct outcomes:
//       - 200 → render the diff
//       - 410 → "diff unavailable for this row" (pre-feature data)
//       - other 4xx/5xx → generic error with retry link
//
// Performance: ~150ms for an average doc (replay + diff + roundtrip).
// We don't show a skeleton for that short a wait — a centered spinner
// is enough and matches what the comments panel does on first load.

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

// Fetch on mount. The parent guards mount/unmount via the expansion
// state, so this also acts as a "fetch when first expanded."
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
