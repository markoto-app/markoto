<script setup lang="ts">
import { parseCommentBody } from '~/utils/comments/commentBody'

// Fetches the comment thread behind an activity row and highlights the row's
// own entry. Doesn't reuse `<CommentItem>`: its delete/resolve actions make no
// sense in read-only history, and the narrow sidebar needs a tighter layout.

interface CommentContextRow {
  entryId: string
  parentCommentId: string | null
  authorId: number | null
  authorName: string
  body: string
  createdAtMs: number
  updatedAtMs: number
  resolved: boolean
}

interface CommentContextResponse {
  activityId: number
  rows: CommentContextRow[]
  focusEntryId: string
}

const props = defineProps<{
  docId: string
  activityId: number
}>()

const { t } = useI18n()

const data = ref<CommentContextResponse | null>(null)
const error = ref<{ kind: 'unavailable' | 'unknown', message?: string } | null>(null)
const loading = ref(true)

async function load() {
  loading.value = true
  error.value = null
  data.value = null
  try {
    data.value = await $fetch<CommentContextResponse>(
      `/api/docs/${props.docId}/activity/${props.activityId}/comment-context`
    )
  } catch (e: unknown) {
    const status = (e as { statusCode?: number, status?: number })?.statusCode
      ?? (e as { status?: number })?.status
    if (status === 410) {
      error.value = { kind: 'unavailable' }
    } else {
      error.value = { kind: 'unknown', message: e instanceof Error ? e.message : String(e) }
    }
  } finally {
    loading.value = false
  }
}

onMounted(load)

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

// Strips mention tokens (`@[Name](user:N)` and bare `@ai`) to plain text; the
// narrow drawer has no room for mention pills.
function plainBody(body: string): string {
  return parseCommentBody(body).map(segText).join('')
}

function segText(seg: ReturnType<typeof parseCommentBody>[number]): string {
  if (seg.kind === 'mention') return `@${seg.name}`
  if (seg.kind === 'ai-mention') return '@markoto'
  return seg.text
}
</script>

<template>
  <div class="activity-row-comment-context">
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
      {{ t('activity.commentContext.unavailable') }}
    </div>

    <div
      v-else-if="error"
      class="text-xs text-muted px-2 py-3 flex items-center gap-2"
    >
      <UIcon
        name="i-lucide-alert-circle"
        class="size-3.5 text-error"
      />
      <span class="flex-1">{{ t('activity.commentContext.error') }}</span>
      <button
        type="button"
        class="text-primary hover:underline"
        @click="load"
      >
        {{ t('activity.commentContext.retry') }}
      </button>
    </div>

    <div
      v-else-if="data"
      class="space-y-1.5"
    >
      <div
        v-for="row in data.rows"
        :key="row.entryId"
        class="rounded border px-2 py-1.5 text-xs"
        :class="row.entryId === data.focusEntryId
          ? 'border-primary/60 bg-primary/5'
          : 'border-default/60 bg-default'"
      >
        <div class="flex items-baseline gap-1.5 text-[11px]">
          <span class="font-semibold text-default truncate">{{ row.authorName }}</span>
          <span
            v-if="row.parentCommentId"
            class="text-muted/70 italic"
          >
            {{ t('activity.commentContext.replyMarker') }}
          </span>
          <span class="text-muted shrink-0 ml-auto">{{ formatTime(row.createdAtMs) }}</span>
        </div>
        <div class="mt-0.5 whitespace-pre-wrap break-words text-default">
          {{ plainBody(row.body) }}
        </div>
        <div
          v-if="row.resolved"
          class="mt-0.5 text-[10px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1"
        >
          <UIcon
            name="i-lucide-check-circle-2"
            class="size-3"
          />
          {{ t('activity.commentContext.resolved') }}
        </div>
      </div>
    </div>
  </div>
</template>
